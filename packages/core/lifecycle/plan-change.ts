import {
  insertOperation,
  lifecycleRepo,
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
//
// WPU-S3. Ruling: (1) while the apply operation of a pending plan is queued or running, the customer
// cannot stop, destroy or re-schedule (planApplyInFlight; the web cores answer busy and fail closed);
// (2) the failure mark `pendingPlanFailed = { code, productId, period }` is not cleared by the
// customer: scheduling the same product is refused, another product is allowed, a cancel leaves the
// mark, and only a successful apply (or an admin, not built) removes it; (3) a mark for the pending
// product keeps the renewal at the applied plan's price (planPriceFor), so the discount is not repeated.
//
// WPU-S4. Ruling: renewal never charges less than the plan the resource actually has — closes the whole
// charge-before-apply bypass class — a downgrade lands one term later than the customer may expect.
// The quote is the catalog price of max(applied plan, pending plan) through the pricing engine, where
// the applied plan is `config.appliedPlan`, or the stored snapshot price when none was applied yet. An
// upgrade is charged at the higher pending price (the capacity follows right after the charge); a
// downgrade is charged at the current (higher) price for that term, the apply runs after the charge,
// and the NEXT renewal quotes the lower applied plan. A failed, blocked or raced apply of a downgrade
// can never give a discount; the apply states, the busy checks and the failure mark stay as secondary
// defences, the billing does not depend on them.

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

const IN_FLIGHT_STATES: readonly string[] = Object.freeze([
  "queued",
  "running",
  "waiting",
  "needs_approval",
]);

/**
 * WPU-S3. True when an apply of a pending plan (scale_container, change_cdn_bundle) is queued, running
 * or waiting for the resource. The renewal has already charged the new price at that point, so the
 * customer must not turn the resource off or destroy it until the apply is over: a stopped resource
 * makes the apply conflict, and the customer would keep the bigger capacity at the cheaper price. A
 * failed apply (needs_attention) is not in flight: that state belongs to the failure mark.
 */
export function planApplyInFlight(
  operations: readonly { readonly kind: string; readonly state: string }[],
): boolean {
  return operations.some(
    (o) => PLAN_APPLY_KINDS.includes(o.kind) && IN_FLIGHT_STATES.includes(o.state),
  );
}

export interface PlanFailure {
  readonly code: string;
  /** The product whose apply failed; null in a mark written before WPU-S3 (code only). */
  readonly productId: string | null;
  /** The start of the billing period the failed apply was charged in; null in an old mark. */
  readonly period: string | null;
}

/** The failure mark of a resource config (`pendingPlanFailed`); anything malformed reads as none. */
export function readPlanFailure(config: unknown): PlanFailure | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const mark = (config as Record<string, unknown>).pendingPlanFailed;
  if (typeof mark !== "object" || mark === null || Array.isArray(mark)) return null;
  const raw = mark as Record<string, unknown>;
  return {
    code: typeof raw.code === "string" ? raw.code : "unknown",
    productId: idOf({ productId: raw.productId }),
    period: typeof raw.period === "string" ? raw.period : null,
  };
}

/**
 * WPU-S3. True when the apply of this product failed and the mark is still there. The customer cannot
 * clear the mark: scheduling or cancelling a plan leaves it; only a successful apply (the adapters) or
 * an admin removes it. A mark without a product (written before WPU-S3) counts for the pending plan.
 */
export function planFailedFor(config: unknown, productId: string): boolean {
  const failure = readPlanFailure(config);
  if (failure === null) return false;
  return (failure.productId ?? readPlanChange(config).pending) === productId;
}

/** True when the apply of the pending plan of this config ended in needs_attention. */
export function planChangeFailed(config: unknown): boolean {
  const { pending } = readPlanChange(config);
  return pending !== null && planFailedFor(config, pending);
}

const REASON_CODE = /^[A-Za-z][A-Za-z0-9_.:]{0,95}$/;

/**
 * An apply operation ended in needs_attention (a failure that will not be retried, or the retries
 * are used up): the pending plan is marked failed with `{ code, productId, period }` (WPU-S3), and no
 * renewal quotes it. The customer cannot clear the mark (scheduling the same product again is refused,
 * see `planFailedFor`). The code is the machine code of the operation, never customer text or an AWS
 * message (R14). Any other kind changes nothing.
 */
export async function markPlanChangeFailed(
  tx: Tx,
  event: {
    readonly resourceId: string;
    readonly kind: string;
    readonly code: string;
    readonly operationId?: string;
  },
): Promise<void> {
  if (!PLAN_APPLY_KINDS.includes(event.kind)) return;
  const code = REASON_CODE.test(event.code) ? event.code : "unknown";
  const facts = await lifecycleRepo(tx).planApplyFacts(event.resourceId, event.operationId);
  // WPU-S4: the failed product is the one in the payload of the failed operation (what the renewal
  // charged and queued), not the live pending plan, which the customer may have changed since. A mark
  // without an operation (an old caller) falls back to the live pending plan.
  const productId =
    facts === null
      ? null
      : (idOf({ productId: facts.operationProductId }) ?? readPlanChange(facts.config).pending);
  await patchResource(tx, event.resourceId, {
    configMerge: {
      pendingPlanFailed: { code, productId, period: facts?.periodStart?.toISOString() ?? null },
    },
  });
}

export type PlanPrice =
  | { readonly state: "snapshot" }
  | {
      readonly state: "applied";
      readonly productId: string;
      readonly awsPriceUsd: string;
    }
  | {
      /**
       * A pending plan the apply can run for. `awsPriceUsd` is the price of the pending product;
       * `floorAwsPriceUsd` is the price of the plan the resource has now (the applied product), or null
       * when none was applied yet and the stored snapshot price is the floor. WPU-S4: the renewal
       * charges the higher of the two.
       */
      readonly state: "pending";
      readonly productId: string;
      readonly awsPriceUsd: string;
      readonly floorAwsPriceUsd: string | null;
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

  // WPU-S4: the plan the resource has now must be readable whatever is pending (R16).
  let floor: string | null = null;
  if (applied !== null) {
    floor = await usable(applied, false);
    if (floor === null) return { state: "unreadable" };
  }
  const applicable =
    spec.applyStates.includes(row.resource.state) &&
    (pending === null || !planFailedFor(row.resource.config, pending));
  if (pending !== null && applicable) {
    const price = await usable(pending, true);
    if (price !== null) {
      return { state: "pending", productId: pending, awsPriceUsd: price, floorAwsPriceUsd: floor };
    }
  }
  if (applied !== null && floor !== null) {
    return { state: "applied", productId: applied, awsPriceUsd: floor };
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
