import { customerRepos, insertOperation, lifecycleRepo, type Tx } from "@tc/db";
import type { Logger } from "../operations/types";
import type { Clock, Result } from "../types";
import { DEFAULT_LIFECYCLE_CONFIG } from "./config";
import { planApplyWait } from "./plan-change";
import { renewSubscription, type Renewed } from "./renew";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_STATES = ["active", "stopped", "suspended"];

/** A renewal is taken at once only this many days before the period end (the first reminder day). */
export const RENEW_NOW_WINDOW_DAYS = Math.max(...DEFAULT_LIFECYCLE_CONFIG.reminderDays);

export interface RenewNowInput {
  /** From the session, never from the form (R8). */
  readonly customerId: string;
  /** The resource whose subscription is renewed. */
  readonly resourceId: string;
  readonly clock: Clock;
  /** Fixed-text structured events only (R14); an invoice that could not be recorded is reported here. */
  readonly log?: Logger;
}

export type RenewedNow = Renewed & { readonly resumeQueued: boolean };

/**
 * 16.10 Billing, `renewNow` (section 11): the customer pays the next period from the wallet now.
 * It runs inside the caller's transaction as web_rw. The subscription is read through the tenant
 * repository (another customer's resource answers `not_found` like a missing one, R8) and then
 * locked; `renewSubscription` takes the wallet lock, prices at today's rate and charges once under
 * the ledger key of the period (R7): a second call finds the new period and is refused, so nothing
 * stacks and nothing is charged twice. Allowed in `grace`, or `active` inside the window before the
 * period end; any other state, or a resource that is not alive, is a `conflict` (R16). From grace a
 * suspended resource is resumed, unless an admin suspended it (section 11).
 */
export async function renewNow(tx: Tx, input: RenewNowInput): Promise<Result<RenewedNow>> {
  const now = input.clock.now();
  if (Number.isNaN(now.getTime())) return { ok: false, error: "internal" };

  const owned = await customerRepos(tx, input.customerId).subscriptions.get(input.resourceId);
  if (owned === null) return { ok: false, error: "not_found" };

  const repo = lifecycleRepo(tx);
  const row = await repo.lock(owned.id);
  // A row that moved to another customer cannot exist; the check keeps the lock honest (R8, R16).
  if (row === null || row.customerId !== input.customerId) return { ok: false, error: "not_found" };

  if (!LIVE_STATES.includes(row.resource.state) || row.resource.deletedAt !== null) {
    return { ok: false, error: "conflict", fields: { subscription: "not_renewable" } };
  }
  const due =
    row.status === "grace" ||
    (row.status === "active" &&
      row.periodEnd.getTime() - now.getTime() <= RENEW_NOW_WINDOW_DAYS * DAY_MS);
  if (!due) return { ok: false, error: "conflict", fields: { subscription: "not_due" } };

  // WPU-S7: while the apply of a pending plan for this period is queued or running, the charge would
  // not follow the capacity the customer has: busy, nothing is charged, and the customer may press
  // again. After the bounded wait the renewal charges the applied plan (the late apply is skipped).
  if ((await planApplyWait(tx, row, now)).wait) {
    return { ok: false, error: "conflict", fields: { subscription: "busy" } };
  }

  const renewed = await renewSubscription(tx, row, input.clock, input.log);
  if (!renewed.ok) return renewed;

  let resumeQueued = false;
  if (
    row.status === "grace" &&
    row.resource.state === "suspended" &&
    row.resource.config.adminSuspended !== true
  ) {
    // The key of the engine's own resume: one resume per renewal, whoever renews.
    const inserted = await insertOperation(
      tx,
      {
        resourceId: row.resourceId,
        kind: "resume",
        payload: { subscriptionId: row.id },
        idempotencyKey: `lifecycle:resume:${row.id}:${renewed.value.periodStart.toISOString()}`,
      },
      now,
    );
    resumeQueued = inserted.created;
  }
  // WPU-S5: a pending plan is applied by the scheduler before the renewal; nothing is queued here.
  await repo.insertNotification({
    customerId: row.customerId,
    channel: "email",
    template: "lifecycle_renewed",
    payload: {
      subscriptionId: row.id,
      resourceId: row.resourceId,
      amountMinor: renewed.value.totalMinor.toString(),
      periodEnd: renewed.value.periodEnd.toISOString(),
    },
    dedupeKey: `lifecycle:lifecycle_renewed:${row.id}:${renewed.value.periodStart.toISOString()}:email`,
  });
  return { ok: true, value: { ...renewed.value, resumeQueued } };
}
