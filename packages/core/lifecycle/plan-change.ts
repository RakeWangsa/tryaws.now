import { insertOperation, readCatalogProduct, type LifecycleRow, type Tx } from "@tc/db";
import { cdnBundleFrom } from "../products/cdn";
import { containerPlanFrom } from "../products/container";
import type { OperationKind } from "../operations/kinds";

// WPU-G8. Ruling: a power, scale or bundle change takes effect at the NEXT renewal. A term is prepaid,
// so there is no proration. The customer's choice is stored in the resource config as
// `pendingPlan: { productId }` (written by the adapter action `schedule_plan_change`). The renewal
// quote reads the price of that catalog product through the pricing engine (the amount is never
// computed here, R4), the renewal queues the operation that applies it, and the adapter then moves
// the plan to `appliedPlan: { productId }`, which keeps pricing the later renewals. The stored price
// snapshot is not touched: worker_rw has no grant on it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface PlanFamily {
  /** The operation that applies the plan: queued by a renewal, never by a customer. */
  readonly apply: OperationKind;
  readonly shaped: (awsId: unknown, specs: unknown) => boolean;
}

const PLAN_FAMILIES: Readonly<Record<string, PlanFamily>> = Object.freeze({
  container_service: {
    apply: "scale_container",
    shaped: (awsId, specs) => containerPlanFrom(awsId, specs) !== null,
  },
  cdn: { apply: "change_cdn_bundle", shaped: (awsId) => cdnBundleFrom(awsId) !== null },
});

export const PLAN_CHANGE_FAMILIES: readonly string[] = Object.freeze(Object.keys(PLAN_FAMILIES));

function idOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).productId;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

/** The pending and the applied product of a resource config; anything malformed reads as none. */
export function readPlanChange(config: unknown): {
  pending: string | null;
  applied: string | null;
} {
  const raw =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  return { pending: idOf(raw.pendingPlan), applied: idOf(raw.appliedPlan) };
}

export type PlanPrice =
  | { readonly state: "snapshot" }
  | {
      readonly state: "pending" | "applied";
      readonly productId: string;
      readonly awsPriceUsd: string;
    }
  | { readonly state: "unreadable" };

type PlanRow = Pick<LifecycleRow, "resource">;

/**
 * Which AWS price the next renewal of this row is quoted from. A valid pending plan wins (it is what
 * the customer will have); else an applied plan; else the stored snapshot, as before. A pending plan
 * that cannot be used (product gone, off sale, another Region, wrong shape) is ignored, so the
 * customer is never charged for a plan that will not be applied. An applied plan that cannot be read
 * makes the price unknown, and the caller refuses to charge (R16).
 */
export async function planPriceFor(tx: Tx, row: PlanRow): Promise<PlanPrice> {
  const spec = PLAN_FAMILIES[row.resource.family];
  if (spec === undefined) return { state: "snapshot" };
  const { pending, applied } = readPlanChange(row.resource.config);
  const region = row.resource.config.region;

  const usable = async (id: string, needActive: boolean): Promise<string | null> => {
    const product = await readCatalogProduct(tx, id);
    if (
      product === null ||
      product.family !== row.resource.family ||
      (needActive && !product.active) ||
      typeof region !== "string" ||
      product.region !== region ||
      !spec.shaped(product.awsId, product.specs)
    ) {
      return null;
    }
    return product.awsPriceUsd;
  };

  if (pending !== null) {
    const price = await usable(pending, true);
    if (price !== null) return { state: "pending", productId: pending, awsPriceUsd: price };
  }
  if (applied !== null) {
    const price = await usable(applied, false);
    return price === null
      ? { state: "unreadable" }
      : { state: "applied", productId: applied, awsPriceUsd: price };
  }
  return { state: "snapshot" };
}

/**
 * After a renewal was charged: queue the operation that applies a pending plan, once per period (the
 * key holds the new period start, R7). The product is the one the quote used, read again under the
 * same transaction. Returns the new operation when one was created.
 */
export async function queuePlanChange(
  tx: Tx,
  row: LifecycleRow,
  periodStart: Date,
  now: Date,
): Promise<{ operationId: string; ready: boolean } | null> {
  const price = await planPriceFor(tx, row);
  if (price.state !== "pending") return null;
  const spec = PLAN_FAMILIES[row.resource.family];
  if (spec === undefined) return null;
  const inserted = await insertOperation(
    tx,
    {
      resourceId: row.resourceId,
      kind: spec.apply,
      payload: { subscriptionId: row.id, productId: price.productId },
      idempotencyKey: `lifecycle:plan-change:${row.id}:${periodStart.toISOString()}`,
    },
    now,
  );
  return inserted.created
    ? { operationId: inserted.operationId, ready: inserted.state === "queued" }
    : null;
}
