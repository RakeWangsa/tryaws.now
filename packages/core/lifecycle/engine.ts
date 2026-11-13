import {
  insertOperation,
  lifecycleRepo,
  patchResource,
  type LifecycleRow,
  type OperationKind,
  type Tx,
} from "@tc/db";
import { walletBalance } from "../ledger/balance";
import {
  firstMessage,
  sendAfterCommit,
  type OperationQueue,
  type QueueMessage,
} from "../operations/queue";
import type { Logger, RunTx } from "../operations/types";
import type { Clock } from "../types";
import { DEFAULT_LIFECYCLE_CONFIG, readLifecycleConfig, type LifecycleConfig } from "./config";
import { decideSubscription, type LifecycleAction } from "./decide";
import { productOfFamily, type NoticeWriter } from "./notice";
import { walletLowDue } from "./unpaid";
import { resumeAfterRenewalAllowed, retentionKeyNeedsSalt } from "./resume-rule";
import { SNAPSHOT_FAMILIES } from "./guard";
import { planApplyWait, queuePlanApply } from "./plan-change";
import { renewalQuote, renewSubscription } from "./renew";
import { isFxRateUnavailable } from "../rates/fx-gate";

const HOUR_MS = 3_600_000;
export const LIFECYCLE_LIMIT = 500;

export interface LifecycleDeps {
  readonly runTx: RunTx;
  // The only source of time (section 11): a test moves it, the function reads the real one.
  readonly clock: Clock;
  readonly log: Logger;
  // With a queue the new operations are sent after the commit; without one the sweeper sends them
  // within minutes (3.4). A lost send is found again by the sweeper either way.
  readonly queue?: OperationQueue;
  readonly limit?: number;
  // WPU-Y3: writes the "your wallet is low for the charge on <date>" message (a template of @tc/notify).
  // Without it that reminder is not sent; the renewal reminder is not affected.
  readonly notice?: NoticeWriter;
}

export interface LifecycleReport {
  readonly examined: number;
  readonly reminded: number;
  readonly renewed: number;
  readonly graced: number;
  readonly retained: number;
  readonly ended: number;
  readonly failed: number;
}

type Step = Exclude<keyof LifecycleReport, "examined" | "failed"> | "none";

interface StepResult {
  readonly step: Step;
  readonly messages: readonly QueueMessage[];
}

// The key of an operation of the lifecycle: one per subscription, kind and period, so a repeat of
// any run is a replay of the stored row (R7) and a new period starts afresh.
function opKey(kind: string, row: LifecycleRow, at: Date): string {
  return `lifecycle:${kind}:${row.id}:${at.toISOString()}`;
}

class Work {
  readonly messages: QueueMessage[] = [];
  constructor(
    readonly tx: Tx,
    readonly row: LifecycleRow,
    readonly now: Date,
    readonly config: LifecycleConfig,
    /** WPU-Y3b. The unpaid episode (its start in ms) when the unpaid job retains the subscription. */
    readonly episode?: number,
  ) {}

  // R1: only an operation row. The queue message goes out after the commit.
  async enqueue(kind: OperationKind, keyAt: Date): Promise<void> {
    const request = (key: string) => ({
      resourceId: this.row.resourceId,
      kind,
      payload: { subscriptionId: this.row.id },
      idempotencyKey: key,
    });
    const key = opKey(kind.replaceAll("_", "-"), this.row, keyAt);
    let inserted = await insertOperation(this.tx, request(key), this.now);
    // WPU-Y3b. A second unpaid episode in the same period must not get the dead (or finished) row of
    // the first one back: when the stored row is such, the episode takes a key of its own.
    if (
      this.episode !== undefined &&
      !inserted.created &&
      retentionKeyNeedsSalt(inserted.state) &&
      (kind === "destroy" || kind === "final_snapshot")
    ) {
      inserted = await insertOperation(this.tx, request(`${key}:u${this.episode}`), this.now);
    }
    if (inserted.created && inserted.state === "queued") {
      this.messages.push(firstMessage(inserted.operationId, this.row.resourceId));
    }
  }

  async notify(
    template: string,
    dedupe: string,
    payload: Record<string, unknown>,
    channels: readonly ("email" | "sms")[] = ["email"],
  ): Promise<boolean> {
    let any = false;
    for (const channel of channels) {
      const written = await lifecycleRepo(this.tx).insertNotification({
        customerId: this.row.customerId,
        channel,
        template,
        payload,
        dedupeKey: `lifecycle:${template}:${dedupe}:${channel}`,
      });
      any = any || written;
    }
    return any;
  }
}

async function amountText(tx: Tx, row: LifecycleRow, clock: Clock): Promise<string | null> {
  const priced = await renewalQuote(tx, row, clock);
  return priced.ok ? priced.value.totalMinor : null;
}

async function ensureSuspended(work: Work): Promise<void> {
  const { row } = work;
  // A resource that is already suspended (by an admin too) needs no operation.
  if (row.resource.state !== "active" && row.resource.state !== "stopped") return;
  await work.enqueue("suspend", row.periodEnd);
}

// WPU-Y1. The key of resources.config that marks a subscription whose renewal could not be priced because the
// USD to BDT rate is missing or older than 7 days. The customer is not at fault: nothing is charged, suspended,
// retained or destroyed because of it, and the renewal is tried again on every sweep (the period start stays the
// OLD period end, so no day is lost and the ledger key stops a second charge, R7). The marker lets a subscription
// whose grace ran out during the hold try to renew once before it is retained.
export const FX_HOLD_KEY = "fxRateHold";

const isHeld = (row: LifecycleRow): boolean => {
  const v = row.resource.config[FX_HOLD_KEY];
  return v !== undefined && v !== null;
};

async function holdForRate(work: Work, deps: LifecycleDeps, where: string): Promise<void> {
  const { row } = work;
  if (!isHeld(row)) {
    await patchResource(work.tx, row.resourceId, {
      configMerge: { [FX_HOLD_KEY]: { since: work.now.toISOString() } },
    });
  }
  // Ids and fixed words only (R14).
  deps.log({
    event: "lifecycle_renewal_held",
    reason: "fx_rate_unavailable",
    where,
    subscriptionId: row.id,
    resourceId: row.resourceId,
  });
}

// WPU-Y9. The hold ends and the renewal then fails for the customer's own reason (the wallet is short): the grace
// starts HERE, not at the old period end. Otherwise a hold of two days or more would use the whole grace up and
// the next sweep would retain the subscription at once, for days the customer never could have paid. The marker
// is cleared and `graceFrom` says when the grace began; decideSubscription runs the grace from it.
export const GRACE_FROM_KEY = "graceFrom";

async function releaseHold(work: Work): Promise<void> {
  await patchResource(work.tx, work.row.resourceId, {
    configMerge: { [FX_HOLD_KEY]: null, [GRACE_FROM_KEY]: work.now.toISOString() },
  });
}

const graceFromOf = (row: LifecycleRow): Date | null => {
  const v = row.resource.config[GRACE_FROM_KEY];
  if (typeof v !== "string") return null;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) || at.toISOString() !== v ? null : at;
};

async function afterRenewal(
  work: Work,
  renewed: { periodStart: Date; totalMinor: bigint; periodEnd: Date },
  fromGrace: boolean,
): Promise<void> {
  const { row } = work;
  if (isHeld(row) || graceFromOf(row) !== null) {
    await patchResource(work.tx, row.resourceId, {
      configMerge: { [FX_HOLD_KEY]: null, [GRACE_FROM_KEY]: null },
    });
  }
  // 11: an admin's suspension is never lifted by a renewal; only an admin action lifts it. WPU-Y3b: nor
  // is a suspension that holds an unpaid usage charge: the unpaid job resumes after that is paid.
  if (fromGrace && resumeAfterRenewalAllowed(row)) {
    await work.enqueue("resume", renewed.periodStart);
  }
  await work.notify("lifecycle_renewed", renewed.periodStart.toISOString(), {
    subscriptionId: row.id,
    resourceId: row.resourceId,
    amountMinor: renewed.totalMinor.toString(),
    periodEnd: renewed.periodEnd.toISOString(),
  });
}

async function enterGrace(work: Work, deps: LifecycleDeps, graceStart?: Date): Promise<void> {
  const { row, config } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "grace");
  await ensureSuspended(work);
  const graceUntil = new Date(
    (graceStart ?? row.periodEnd).getTime() + config.graceHours * HOUR_MS,
  );
  await work.notify(
    "lifecycle_grace_started",
    row.periodEnd.toISOString(),
    {
      subscriptionId: row.id,
      resourceId: row.resourceId,
      graceUntil: graceUntil.toISOString(),
      renewalAmountMinor: await amountText(work.tx, row, deps.clock),
    },
    ["email", "sms"],
  );
}

// Also what a customer's own destroy flow (WP5-T6) calls: the state becomes `retained`, the final
// snapshot is queued where the family has snapshots, and the destroy follows it. Before the end
// date of R13 the destroy waits for an admin (the insert path decides); the guard checks the state
// and the snapshot again when it is claimed.
async function retain(work: Work): Promise<void> {
  const { row } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "retained");
  await queueRetentionOperations(work);
}

// WPU-Y3: the unpaid-usage rule retains a subscription at 7 days unpaid. The same steps as the end of
// a grace period (state `retained`, final snapshot where the product has one, destroy), with the same
// keys, so the engine's own `ensure_retention_operations` pass replays them. The destroy waits for an
// admin until the end date of R13 (insertOperation decides). Returns the queue messages to send after
// the commit.
export async function retainSubscription(
  tx: Tx,
  row: LifecycleRow,
  now: Date,
  /** WPU-Y3b. The start of the unpaid episode in ms, for the keys of the destroy and the final snapshot. */
  episode?: number,
): Promise<QueueMessage[]> {
  const work = new Work(tx, row, now, DEFAULT_LIFECYCLE_CONFIG, episode);
  await retain(work);
  return work.messages;
}

async function queueRetentionOperations(work: Work): Promise<void> {
  if (SNAPSHOT_FAMILIES.includes(work.row.resource.family)) {
    await work.enqueue("final_snapshot", work.row.periodEnd);
  }
  await work.enqueue("destroy", work.row.periodEnd);
}

async function end(work: Work): Promise<void> {
  const { row } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "ended");
  await work.enqueue("purge_snapshots", row.periodEnd);
  await work.notify("lifecycle_ended", row.periodEnd.toISOString(), {
    subscriptionId: row.id,
    resourceId: row.resourceId,
  });
}

async function remind(work: Work, day: number, deps: LifecycleDeps): Promise<boolean> {
  const { row, config } = work;
  const balance = await walletBalance(work.tx, row.customerId);
  // WPU-Y3: 3 days and 1 day before an auto-renewal that the wallet cannot cover, once each.
  const product = productOfFamily(row.resource.family);
  if (deps.notice !== undefined && row.autoRenew && product !== null) {
    const amount = await amountText(work.tx, row, deps.clock);
    const amountMinor = amount === null ? null : BigInt(amount);
    if (walletLowDue({ day, balanceMinor: balance, amountMinor })) {
      await deps.notice(work.tx, {
        customerId: row.customerId,
        template: "wallet_low_before_charge",
        data: {
          resourceId: row.resourceId,
          product,
          days: day,
          chargeDate: row.periodEnd.toISOString(),
          amountMinor: amount,
          balanceMinor: balance.toString(),
        },
        dedupeKey: `wallet-low:${row.id}:${row.periodEnd.getTime()}:${day}`,
      });
    }
  }
  return work.notify(
    "lifecycle_renewal_reminder",
    `${row.id}:${row.periodEnd.toISOString()}:${day}`,
    {
      subscriptionId: row.id,
      resourceId: row.resourceId,
      day,
      periodEnd: row.periodEnd.toISOString(),
      renewalAmountMinor: await amountText(work.tx, row, deps.clock),
      balanceMinor: balance.toString(),
    },
    day === config.smsReminderDay ? ["email", "sms"] : ["email"],
  );
}

// One subscription, in its own transaction, under the lock of its row. The decision is taken again
// on the locked row, so two runs together never act twice (and the ledger key stops the money).
async function process(
  tx: Tx,
  id: string,
  now: Date,
  config: LifecycleConfig,
  deps: LifecycleDeps,
): Promise<StepResult> {
  const row = await lifecycleRepo(tx).lock(id);
  if (row === null) return { step: "none", messages: [] };
  const work = new Work(tx, row, now, config);
  const clock: Clock = { now: () => now };

  const action: LifecycleAction = decideSubscription(
    {
      status: row.status,
      periodEnd: row.periodEnd,
      autoRenew: row.autoRenew,
      resourceState: row.resource.state,
      destroyedAt: row.resource.deletedAt,
      graceFrom: graceFromOf(row),
    },
    now,
    config,
  );

  // WPU-S5: a pending power, scale or bundle change is applied shortly BEFORE the renewal, so the
  // renewal charges the plan the customer then has. Inside the lead window only, once per period.
  const plan = await queuePlanApply(tx, row, now);
  if (plan !== null && plan.ready)
    work.messages.push(firstMessage(plan.operationId, row.resourceId));

  // WPU-S7: a renewal that would charge waits for an apply of this period that is still queued or
  // running (the charge must follow the capacity the customer has). It is neither charged nor failed:
  // the next sweep asks again, for at most PLAN_APPLY_WAIT_HOURS past the due time. After that the
  // renewal goes on at the applied plan, ops are told once, and the late apply is skipped by the
  // adapter because the period has moved. Renewals that cannot be paid enter grace as before.
  if ((action.type === "period_end" && action.tryRenew) || action.type === "retry_renew") {
    const gate = await planApplyWait(tx, row, now);
    if (gate.wait) return { step: "none", messages: work.messages };
    if (
      gate.staleOperationId !== null &&
      (row.resource.config.planApplyLate as { operationId?: unknown } | undefined)?.operationId !==
        gate.staleOperationId
    ) {
      await patchResource(tx, row.resourceId, {
        configMerge: {
          planApplyLate: {
            operationId: gate.staleOperationId,
            periodEnd: row.periodEnd.toISOString(),
          },
        },
      });
      deps.log({
        event: "lifecycle",
        action: "plan_apply_late",
        subscriptionId: row.id,
        operationId: gate.staleOperationId,
      });
    }
  }

  let step: Step = "none";
  switch (action.type) {
    case "remind":
      // A repeat of the same reminder writes no row (dedupe key) and is no step (R7).
      if (await remind(work, action.day, deps)) step = "reminded";
      break;
    case "period_end": {
      if (action.tryRenew) {
        const renewed = await renewSubscription(tx, row, clock, deps.log);
        if (renewed.ok) {
          await afterRenewal(work, renewed.value, false);
          step = "renewed";
          break;
        }
        // WPU-Y1: our rate is the problem, not the customer's wallet. No grace, no suspension: the renewal
        // stays pending and the next sweep prices it again (R16 refuses the price, R7 stops a double charge).
        if (isFxRateUnavailable(renewed)) {
          await holdForRate(work, deps, "period_end");
          break;
        }
      }
      // WPU-Y10. A subscription WITHOUT auto-renew has no renewal to try, but the customer's way to pay by hand
      // needs a price too (renewNow refuses with prices_updating). While our rate is missing or stale the period
      // end is held like a renewal: no grace, no suspension, so the platform's gap never costs the customer days.
      if (!action.tryRenew && isFxRateUnavailable(await renewalQuote(tx, row, clock))) {
        await holdForRate(work, deps, "period_end");
        break;
      }
      // WPU-Y9: a renewal that was held for the rate and now fails for the wallet starts its grace now.
      const fromHold = isHeld(row);
      if (fromHold) await releaseHold(work);
      await enterGrace(work, deps, fromHold ? work.now : undefined);
      step = "graced";
      break;
    }
    case "retry_renew": {
      const renewed = await renewSubscription(tx, row, clock, deps.log);
      if (renewed.ok) {
        await afterRenewal(work, renewed.value, true);
        step = "renewed";
      } else if (isFxRateUnavailable(renewed)) {
        await holdForRate(work, deps, "retry_renew");
      } else {
        if (isHeld(row)) await releaseHold(work); // WPU-Y9: the grace starts at the release
        await ensureSuspended(work);
      }
      break;
    }
    case "retain": {
      // WPU-Y1. A subscription is never retained (and so never destroyed) while its renewal cannot be priced.
      // One whose grace ran out during such a hold gets one renewal before it is retained.
      // WPU-Y10. Without auto-renew nothing is ever charged here. While the rate cannot be priced the retention
      // waits too; once the rate is back the grace runs from that moment (graceFrom), exactly as for a held renewal.
      if (!row.autoRenew) {
        if (isFxRateUnavailable(await renewalQuote(tx, row, clock))) {
          await holdForRate(work, deps, "retain");
          break;
        }
        if (isHeld(row)) {
          await releaseHold(work);
          await ensureSuspended(work);
          break;
        }
      }
      if (row.autoRenew) {
        if (isHeld(row)) {
          const renewed = await renewSubscription(tx, row, clock, deps.log);
          if (renewed.ok) {
            await afterRenewal(work, renewed.value, true);
            step = "renewed";
            break;
          }
          if (isFxRateUnavailable(renewed)) {
            await holdForRate(work, deps, "retain");
            break;
          }
          // WPU-Y9: the grace ran out during the hold and the wallet is short now. The customer gets the grace
          // from this release; nothing is retained in this sweep.
          await releaseHold(work);
          await ensureSuspended(work);
          break;
        } else if (isFxRateUnavailable(await renewalQuote(tx, row, clock))) {
          await holdForRate(work, deps, "retain");
          break;
        }
      }
      await retain(work);
      step = "retained";
      break;
    }
    case "ensure_retention_operations":
      await queueRetentionOperations(work);
      break;
    case "end":
      await end(work);
      step = "ended";
      break;
    case "none":
      // A subscription in grace whose suspend never ran gets it queued again (a replay if it exists).
      if (row.status === "grace") await ensureSuspended(work);
      break;
  }
  return { step, messages: work.messages };
}

// The scheduler's lifecycle pass (section 11). One clock reading for the whole pass. A failure of
// one subscription is counted and logged by id and does not stop the others; a config that cannot
// be read stops the pass (R16).
export async function runLifecycle(deps: LifecycleDeps): Promise<LifecycleReport> {
  const now = deps.clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("lifecycle: the clock gave no valid time");
  const limit = deps.limit ?? LIFECYCLE_LIMIT;

  const { config, ids } = await deps.runTx(async (tx) => {
    const config = await readLifecycleConfig(tx);
    const horizon = Math.max(...config.reminderDays);
    return { config, ids: await lifecycleRepo(tx).listCandidates(now, horizon, limit) };
  });

  const counts = { reminded: 0, renewed: 0, graced: 0, retained: 0, ended: 0, failed: 0 };
  const outbox: QueueMessage[] = [];
  for (const id of ids) {
    try {
      // runTx can run its callback again: everything built here is local to one run.
      const result = await deps.runTx((tx) => process(tx, id, now, config, deps));
      if (result.step !== "none") {
        counts[result.step] += 1;
        deps.log({ event: "lifecycle", action: result.step, subscriptionId: id });
      }
      outbox.push(...result.messages);
    } catch (error) {
      counts.failed += 1;
      // The name of the error and the id: never its message or its data (R14).
      deps.log({
        event: "lifecycle",
        action: "error",
        subscriptionId: id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (deps.queue !== undefined) {
    for (const message of outbox) await sendAfterCommit(deps.queue, message);
  }
  return { examined: ids.length, ...counts };
}
