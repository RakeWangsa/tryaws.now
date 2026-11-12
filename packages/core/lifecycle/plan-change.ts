import {
  insertOperation,
  lifecycleRepo,
  patchResource,
  readCatalogProduct,
  type LifecycleRow,
  type Tx,
} from "@tc/db";
import { walletBalance } from "../ledger/balance";
import { cdnBundleFrom } from "../products/cdn";
import { containerPlanFrom } from "../products/container";
import { parseSnapshot } from "../pricing/snapshot";
import { quoteInForce } from "../rates/in-force";
import type { OperationKind } from "../operations/kinds";
import type { Clock } from "../types";

// WPU-G8. Ruling: a power, scale or bundle change takes effect at the NEXT renewal. A term is prepaid,
// so there is no proration. The customer's choice is stored in the resource config as
// `pendingPlan: { productId }` (written by the adapter action `schedule_plan_change`). The scheduler
// queues the operation that applies it shortly before the renewal (WPU-S5), and the adapter then moves
// the plan to `appliedPlan: { productId }`. The renewal quote reads the price of the APPLIED catalog
// product through the pricing engine (the amount is never computed here, R4). The stored price
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
// WPU-S4 (replaced by WPU-S5, never owner-approved): the quote was max(applied, pending) and the apply
// ran after the charge; the money review showed it overcharging a downgrade.
//
// WPU-S5. Ruling: the charge follows the delivered capacity (replaces the WPU-S4 max() rule, which the
// money review showed overcharging a downgrade; S4 was NOT owner-approved) — closes both overcharge
// paths and needs no refund — a plan change lands shortly before the renewal, or one term later if the
// apply is late. (a) The scheduler queues the apply operation (scale_container, change_cdn_bundle)
// PLAN_APPLY_LEAD_HOURS before the renewal is due, once per subscription and period (the key holds the
// period end, R7), only while the resource is in an apply state and the pending plan has not failed.
// (b) The renewal quote prices EXACTLY the plan the resource has: `config.appliedPlan`, else the
// stored snapshot. The pending plan is never priced and the renewal queues nothing after the charge.
// (c) An apply that has not finished at the renewal, or failed, leaves the old plan at the old price;
// the pending plan stays pending for the next period. (d) The apply states, the busy checks and the
// failure mark stay as secondary defences.
//
// WPU-S7. Ruling: the apply is bound to its period and to the money. (a) The apply payload carries the
// subscription id and the period end it was queued for; both adapters treat an apply whose period end
// is not the subscription's current one as stale: nothing is changed in AWS and the pending plan stays
// for the next period. (b) While an apply for the CURRENT period is queued or running, the renewal
// (scheduler or renewNow) is deferred, at most PLAN_APPLY_WAIT_HOURS past the due time; after that the
// renewal charges the applied plan, and the late apply is stale by (a). (c) An UPGRADE is queued only
// when the renewal can be paid: autoRenew is on and the wallet covers the renewal price of the pending
// plan (priced once through the pricing engine, a guard, never posted). A DOWNGRADE is always queued.
// Anything unreadable queues nothing (R16).

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

/**
 * WPU-M4. True when a `clear_plan_change_mark` operation also drops the pending plan: the payload says
 * so (`clearPendingPlan: true`, written when the wallet was credited for a failed apply) and names the
 * product of that apply, and the pending plan of the config is still that product. A plan the customer
 * scheduled since is kept; a flag without a product drops nothing (R16).
 */
export function clearsPendingPlan(payload: unknown, config: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  if ((payload as Record<string, unknown>).clearPendingPlan !== true) return false;
  const named = idOf(payload);
  return named !== null && readPlanChange(config).pending === named;
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
  | { readonly state: "unreadable" };

type PlanRow = Pick<LifecycleRow, "resource">;

/** The usable catalog price of a product for this row, or null (gone, other family or Region, wrong shape). */
async function catalogPrice(
  tx: Tx,
  row: PlanRow,
  spec: PlanFamily,
  id: string,
  needActive: boolean,
): Promise<string | null> {
  const region = row.resource.config.region;
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
}

/**
 * Which AWS price the next renewal of this row is quoted from (WPU-S5): the plan the resource HAS, that
 * is the applied plan, else the stored snapshot. The pending plan is never priced: it is charged only
 * after the apply made it the applied plan. An applied plan that cannot be read makes the price
 * unknown, and the caller refuses to charge (R16).
 */
export async function planPriceFor(tx: Tx, row: PlanRow): Promise<PlanPrice> {
  const spec = PLAN_FAMILIES[row.resource.family];
  if (spec === undefined) return { state: "snapshot" };
  const { applied } = readPlanChange(row.resource.config);
  if (applied === null) return { state: "snapshot" };
  const price = await catalogPrice(tx, row, spec, applied, false);
  if (price === null) return { state: "unreadable" };
  return { state: "applied", productId: applied, awsPriceUsd: price };
}

/** WPU-S7: the longest a renewal waits for an apply of the current period, counted from the due time. */
export const PLAN_APPLY_WAIT_HOURS = 6;

/** The idempotency key of the apply of one subscription and period (R7). */
export function planApplyKey(subscriptionId: string, periodEnd: Date): string {
  return `lifecycle:plan-change:${subscriptionId}:${periodEnd.toISOString()}`;
}

/** What an apply payload names: the product, the subscription and the period end it was queued for. */
export function readPlanApplyPayload(payload: unknown): {
  productId: string | null;
  subscriptionId: string | null;
  periodEnd: Date | null;
} {
  const raw =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const sub = raw.subscriptionId;
  const end = typeof raw.periodEnd === "string" ? new Date(raw.periodEnd) : null;
  return {
    productId: idOf({ productId: raw.productId }),
    subscriptionId: typeof sub === "string" && UUID.test(sub) ? sub : null,
    periodEnd: end !== null && !Number.isNaN(end.getTime()) ? end : null,
  };
}

/**
 * WPU-S7. True unless the payload's period end IS the subscription's current period end. A payload
 * without a period end (queued before WPU-S7), or a current period end that could not be read, is
 * stale: the apply is skipped, never run (R16), and the pending plan waits for the next period.
 */
export function planApplyStale(
  payloadPeriodEnd: Date | null,
  currentPeriodEnd: Date | null,
): boolean {
  if (payloadPeriodEnd === null || currentPeriodEnd === null) return true;
  return payloadPeriodEnd.getTime() !== currentPeriodEnd.getTime();
}

export type PlanApplyWait =
  { readonly wait: true } | { readonly wait: false; readonly staleOperationId: string | null };

/**
 * WPU-S7. Whether a renewal of this row waits for the apply of the current period. It waits while that
 * apply (the operation under the key of this period) is queued, running or waiting, and only until
 * PLAN_APPLY_WAIT_HOURS after the period end. Past that the renewal goes on and the id of the
 * unfinished apply is returned, so the caller can tell ops; the apply then finds the period moved and
 * is skipped by the adapter. An apply that finished or failed does not make it wait.
 */
export async function planApplyWait(tx: Tx, row: LifecycleRow, now: Date): Promise<PlanApplyWait> {
  if (PLAN_FAMILIES[row.resource.family] === undefined)
    return { wait: false, staleOperationId: null };
  const ops = await lifecycleRepo(tx).operationsByKey(
    row.resourceId,
    planApplyKey(row.id, row.periodEnd),
  );
  const open = ops.find(
    (o) => PLAN_APPLY_KINDS.includes(o.kind) && IN_FLIGHT_STATES.includes(o.state),
  );
  if (open === undefined) return { wait: false, staleOperationId: null };
  const limit = row.periodEnd.getTime() + PLAN_APPLY_WAIT_HOURS * 3_600_000;
  if (Number.isNaN(now.getTime()) || now.getTime() < limit) return { wait: true };
  return { wait: false, staleOperationId: open.id };
}

/** The renewal total of this row at an AWS price today (the pricing engine; nothing is posted). */
async function renewalTotalAt(
  tx: Tx,
  row: LifecycleRow,
  awsPriceUsd: string,
  now: Date,
): Promise<bigint | null> {
  let quantity: string;
  try {
    quantity = parseSnapshot(row.priceSnapshot).quantity;
  } catch {
    return null;
  }
  const clock: Clock = { now: () => now };
  const priced = await quoteInForce(
    tx,
    { market: row.market, productFamily: row.resource.family, awsPriceUsd, quantity },
    clock,
  );
  return priced.ok ? BigInt(priced.value.snapshot.totalMinor) : null;
}

/**
 * WPU-S7 (c). "allow" for a downgrade or an equal price; for an upgrade only when autoRenew is on and
 * the wallet covers the renewal price of the pending plan. A price, a rate or a wallet that cannot be
 * read refuses (R16). The prices come from the pricing engine; nothing is compared as text or float.
 */
async function upgradeGuard(
  tx: Tx,
  row: LifecycleRow,
  pendingAwsPriceUsd: string,
  now: Date,
): Promise<"allow" | "refuse"> {
  const spec = PLAN_FAMILIES[row.resource.family];
  if (spec === undefined) return "refuse";
  const current = await planPriceFor(tx, row);
  if (current.state === "unreadable") return "refuse";
  let currentAws: string;
  if (current.state === "applied") {
    currentAws = current.awsPriceUsd;
  } else {
    try {
      currentAws = parseSnapshot(row.priceSnapshot).awsPriceUsd;
    } catch {
      return "refuse";
    }
  }
  const currentTotal = await renewalTotalAt(tx, row, currentAws, now);
  const pendingTotal = await renewalTotalAt(tx, row, pendingAwsPriceUsd, now);
  if (currentTotal === null || pendingTotal === null) return "refuse";
  if (pendingTotal <= currentTotal) return "allow";
  if (!row.autoRenew) return "refuse";
  try {
    return (await walletBalance(tx, row.customerId)) >= pendingTotal ? "allow" : "refuse";
  } catch {
    return "refuse";
  }
}

/** WPU-S5: how long before the renewal is due the apply of a pending plan is queued. */
export const PLAN_APPLY_LEAD_HOURS = 24;

/** True from PLAN_APPLY_LEAD_HOURS before the period end until the period end (the lead window). */
export function planApplyDue(periodEnd: Date, now: Date): boolean {
  const at = now.getTime();
  const end = periodEnd.getTime();
  if (Number.isNaN(at) || Number.isNaN(end)) return false;
  return at >= end - PLAN_APPLY_LEAD_HOURS * 3_600_000 && at < end;
}

/**
 * WPU-S5: in the lead window before a renewal, queue the operation that applies a pending plan, once
 * per subscription and period (the key holds the period end, so a repeat of any scheduler run is a
 * replay, R7). Nothing is queued unless the subscription is active, the resource is in a
 * state the apply runs in (PLAN_APPLY_STATES), the pending plan has not failed, the pending product is
 * still on sale and shaped for the family, and the applied plan can be read (R16). Returns the new
 * operation when one was created. It never charges anything.
 */
export async function queuePlanApply(
  tx: Tx,
  row: LifecycleRow,
  now: Date,
): Promise<{ operationId: string; ready: boolean } | null> {
  const spec = PLAN_FAMILIES[row.resource.family];
  if (spec === undefined) return null;
  if (row.status !== "active") return null;
  if (row.resource.deletedAt !== null || !spec.applyStates.includes(row.resource.state))
    return null;
  if (!planApplyDue(row.periodEnd, now)) return null;
  const { pending, applied } = readPlanChange(row.resource.config);
  if (pending === null || pending === applied || planFailedFor(row.resource.config, pending)) {
    return null;
  }
  if ((await planPriceFor(tx, row)).state === "unreadable") return null;
  const pendingPrice = await catalogPrice(tx, row, spec, pending, true);
  if (pendingPrice === null) return null;
  // WPU-S7 (c): an UPGRADE is queued only when its renewal can be paid. The pending plan is priced
  // once through the pricing engine as a guard; nothing is posted. A DOWNGRADE (not dearer than the
  // current plan) is always queued: it lowers the capacity before a lower charge.
  const guard = await upgradeGuard(tx, row, pendingPrice, now);
  if (guard === "refuse") return null;
  const inserted = await insertOperation(
    tx,
    {
      resourceId: row.resourceId,
      kind: spec.apply,
      payload: {
        subscriptionId: row.id,
        productId: pending,
        periodEnd: row.periodEnd.toISOString(),
      },
      idempotencyKey: planApplyKey(row.id, row.periodEnd),
    },
    now,
  );
  return inserted.created
    ? { operationId: inserted.operationId, ready: inserted.state === "queued" }
    : null;
}
