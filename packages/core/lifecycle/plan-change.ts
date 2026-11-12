import {
  insertOperation,
  patchResource,
  readCatalogProduct,
  type LifecycleRow,
  type Tx,
} from "@tc/db";
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
//
// WPU-S2. Ruling: the pending price is quoted only when the apply operation can run for the state the
// resource is in (PLAN_APPLY_STATES, the states the adapter actions accept), and only while the
// pending plan has not failed (`pendingPlanFailed`, written when the apply ends in needs_attention).
// Otherwise the renewal charges the CURRENT plan and the pending plan stays pending. A customer is
// never charged the price of capacity that is not delivered, and never keeps bigger capacity at a
// smaller price.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface PlanFamily {
  /** The operation that applies the plan: queued by a renewal, never by a customer. */
  readonly apply: OperationKind;
  /**
   * The resource states in which that operation runs. The adapter actions (packages/aws
   * scale_container and change_cdn_bundle) accept `active` only and refuse the rest with a conflict;
   * a stopped resource is therefore NOT applicable, and this list must change with the adapters.
   */
  readonly applyStates: readonly string[];
  readonly shaped: (awsId: unknown, specs: unknown) => boolean;
}

const PLAN_FAMILIES: Readonly<Record<string, PlanFamily>> = Object.freeze({
  container_service: {
    apply: "scale_container",
    applyStates: Object.freeze(["active"]),
    shaped: (awsId, specs) => containerPlanFrom(awsId, specs) !== null,
  },
  cdn: {
    apply: "change_cdn_bundle",
    applyStates: Object.freeze(["active"]),
    shaped: (awsId) => cdnBundleFrom(awsId) !== null,
  },
});

/** The resource states in which the apply operation of each plan family runs. */
export const PLAN_APPLY_STATES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(PLAN_FAMILIES).map(([family, f]) => [family, f.applyStates])),
);

/** The operation kinds that apply a pending plan; the failure of one marks the plan as failed. */
export const PLAN_APPLY_KINDS: readonly string[] = Object.freeze(
  Object.values(PLAN_FAMILIES).map((f) => f.apply),
);

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

/** True when the apply of the pending plan ended in needs_attention (`pendingPlanFailed`). */
export function planChangeFailed(config: unknown): boolean {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  const failed = (config as Record<string, unknown>).pendingPlanFailed;
  return typeof failed === "object" && failed !== null && !Array.isArray(failed);
}

const REASON_CODE = /^[A-Za-z][A-Za-z0-9_.:]{0,95}$/;

/**
 * An apply operation ended in needs_attention (a failure that will not be retried, or the retries
 * are used up): the pending plan is marked failed with the reason code, and no renewal quotes it
 * until the customer or an admin schedules a plan again (`schedule_plan_change` clears the mark). The
 * code is the machine code of the operation, never customer text or an AWS message (R14). Any other
 * kind changes nothing.
 */
export async function markPlanChangeFailed(
  tx: Tx,
  event: { readonly resourceId: string; readonly kind: string; readonly code: string },
): Promise<void> {
  if (!PLAN_APPLY_KINDS.includes(event.kind)) return;
  const code = REASON_CODE.test(event.code) ? event.code : "unknown";
  await patchResource(tx, event.resourceId, { configMerge: { pendingPlanFailed: { code } } });
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
 * the customer will have) when the apply can run in the state the resource is in and has not failed
 * before (WPU-S2); else an applied plan; else the stored snapshot, as before. A pending plan that
 * cannot be used (product gone, off sale, another Region, wrong shape, resource state not
 * applicable, earlier apply failed) is ignored, so the customer is never charged for a plan that
 * will not be applied. An applied plan that cannot be read
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

  const applicable =
    spec.applyStates.includes(row.resource.state) && !planChangeFailed(row.resource.config);
  if (pending !== null && applicable) {
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
