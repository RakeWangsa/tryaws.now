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
import { queueDomainRenewal } from "./domain-renewal";
import { productOfFamily, type NoticeWriter } from "./notice";
import { walletLowDue } from "./unpaid";
import { resumeAfterRenewalAllowed, retentionKeyNeedsSalt } from "./resume-rule";
import { SNAPSHOT_FAMILIES } from "./guard";
import { planApplyWait, queuePlanApply } from "./plan-change";
import { renewalQuote, renewSubscription } from "./renew";
import { holdReasonOf, nextHoldMarker, staleHoldMarkers, type HoldReason } from "./hold-rule";
import { walkCandidates } from "./candidate-walk";

const HOUR_MS = 3_600_000;
// The rows of one page of the pass's candidate list. WPU-Z12: a page, no longer the most rows of a pass.
export const LIFECYCLE_LIMIT = 500;
// WPU-Z12 review: the upper bound of a pass, in ms from its clock reading. No row starts after it. About a third of the
// scheduler's run (55 s, infra/lib/functions.ts), so the jobs after the pass in the same run (metering, static IPs,
// unpaid, invoices, rate watch) keep the rest. Before WPU-Z12 a pass read at most 500 rows.
export const LIFECYCLE_BUDGET_MS = 20_000;

/**
 * WPU-Z12 review. The pass used up its time budget before the end of its candidate list. The rows it did are
 * committed and their messages sent; the rest are candidates again on the next pass, which starts at the head. It is a
 * failure of the job (R16): the scheduler's run then rejects and its Errors alarm fires, because a pass cut on every
 * run would never reach the rows after the cut.
 */
export class LifecyclePassCutError extends Error {
  constructor() {
    // Fixed words only (R14): no id, no time.
    super("lifecycle: the pass reached its time budget before the end of the candidate list");
    this.name = "LifecyclePassCutError";
  }
}

export interface LifecycleDeps {
  readonly runTx: RunTx;
  // The only source of time (section 11): a test moves it, the function reads the real one.
  readonly clock: Clock;
  readonly log: Logger;
  // With a queue the new operations are sent after the commit; without one the sweeper sends them
  // within minutes (3.4). A lost send is found again by the sweeper either way.
  readonly queue?: OperationQueue;
  // WPU-Z12: the rows of one page of the candidate list (LIFECYCLE_LIMIT by default). Not a cap: the pass
  // reads every page.
  readonly pageSize?: number;
  // WPU-Z12 review: the time budget of the pass in ms (LIFECYCLE_BUDGET_MS by default). `clock` is read again before
  // each row; once this much time has passed since the pass's own reading no row starts (LifecyclePassCutError).
  readonly budgetMs?: number;
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
// WPU-Z1 (R16). The same hold, under the same key, for every other failure to price or post the renewal that is
// not the customer's wallet (a stored price that cannot be read, no pricing rule in force, a ledger refusal). The
// marker says why: `{ since, reason: "fx_rate" | "price_unavailable", error? }` (hold-rule.ts).
export const FX_HOLD_KEY = "fxRateHold";

const isHeld = (row: LifecycleRow): boolean => {
  const v = row.resource.config[FX_HOLD_KEY];
  return v !== undefined && v !== null;
};

async function holdRenewal(
  work: Work,
  deps: LifecycleDeps,
  where: string,
  why: HoldReason,
): Promise<void> {
  const { row } = work;
  // Written once: a repeat writes nothing, another reason updates the reason only (`since` never moves).
  const marker = nextHoldMarker(row.resource.config[FX_HOLD_KEY], why, work.now);
  if (marker !== null) {
    await patchResource(work.tx, row.resourceId, { configMerge: { [FX_HOLD_KEY]: marker } });
  }
  // Ids and fixed words only (R14): the error is a code of ErrorCode, never a message. The line with
  // reason price_unavailable alarms (infra/stacks/alarms.ts): a person has to repair the price.
  deps.log({
    event: "lifecycle_renewal_held",
    ...(why.reason === "fx_rate"
      ? { reason: "fx_rate_unavailable" }
      : { reason: "price_unavailable", error: why.error }),
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

// WPU-Z1. renewNow (the customer pays by hand) runs as web_rw, which cannot write resources.config, so the hold
// marker and the graceFrom of the period it paid stay behind. Once the subscription is active again with its period
// end ahead they are stale (hold-rule.ts) and are cleared here, before the decision: left alone, a stale hold marker
// would move the start of a later period's grace from that period end to a sweep (WPU-Y9). In no other state is a
// marker cleared here.
async function clearStaleMarkers(tx: Tx, row: LifecycleRow, now: Date): Promise<LifecycleRow> {
  const config = row.resource.config;
  const view = {
    status: row.status,
    periodEnd: row.periodEnd,
    hold: config[FX_HOLD_KEY],
    graceFrom: config[GRACE_FROM_KEY],
  };
  if (!staleHoldMarkers(view, now)) return row;
  const cleared = { [FX_HOLD_KEY]: null, [GRACE_FROM_KEY]: null };
  await patchResource(tx, row.resourceId, { configMerge: cleared });
  return { ...row, resource: { ...row.resource, config: { ...config, ...cleared } } };
}

async function afterRenewal(
  work: Work,
  renewed: { periodStart: Date; totalMinor: bigint; periodEnd: Date; awsPriceUsd: string },
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
  // WPU-Z13: a domain's charge pays the registry: its renew_domain of the period, in this transaction (R7).
  const registry = await queueDomainRenewal(
    work.tx,
    row,
    renewed.periodStart,
    work.now,
    renewed.awsPriceUsd,
  );
  if (registry !== null) work.messages.push(registry);
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
  const locked = await lifecycleRepo(tx).lock(id);
  if (locked === null) return { step: "none", messages: [] };
  // WPU-Z1: markers that a renewal by hand left behind go first, so nothing below reads them.
  const row = await clearStaleMarkers(tx, locked, now);
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
        // WPU-Z1: the same for every other failure that is not the wallet (insufficient_balance).
        const why = holdReasonOf(renewed);
        if (why !== null) {
          await holdRenewal(work, deps, "period_end", why);
          break;
        }
      } else {
        // WPU-Y10. A subscription WITHOUT auto-renew has no renewal to try, but the customer's way to pay by hand
        // needs a price too (renewNow refuses without one). While it cannot be priced (WPU-Z1: for any reason, our
        // rate or not) the period end is held like a renewal: no grace, no suspension, so the platform's gap never
        // costs the customer days.
        const why = holdReasonOf(await renewalQuote(tx, row, clock));
        if (why !== null) {
          await holdRenewal(work, deps, "period_end", why);
          break;
        }
      }
      // WPU-Y9: a renewal that was held and now fails for the wallet starts its grace now.
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
        break;
      }
      // WPU-Y1, WPU-Z1: held when the wallet is not the reason.
      const why = holdReasonOf(renewed);
      if (why !== null) {
        await holdRenewal(work, deps, "retry_renew", why);
        break;
      }
      if (isHeld(row)) await releaseHold(work); // WPU-Y9: the grace starts at the release
      await ensureSuspended(work);
      break;
    }
    case "retain": {
      // WPU-Y1. A subscription is never retained (and so never destroyed) while its renewal cannot be priced.
      // One whose grace ran out during such a hold gets one renewal before it is retained.
      // WPU-Y10. Without auto-renew nothing is ever charged here. While the rate cannot be priced the retention
      // waits too; once the rate is back the grace runs from that moment (graceFrom), exactly as for a held renewal.
      // WPU-Z1. "Cannot be priced" is any failure that is not the wallet: our rate, a stored price that cannot be
      // read, no pricing rule in force, a ledger refusal.
      if (!row.autoRenew) {
        const why = holdReasonOf(await renewalQuote(tx, row, clock));
        if (why !== null) {
          await holdRenewal(work, deps, "retain", why);
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
          const why = holdReasonOf(renewed);
          if (why !== null) {
            await holdRenewal(work, deps, "retain", why);
            break;
          }
          // WPU-Y9: the grace ran out during the hold and the wallet is short now. The customer gets the grace
          // from this release; nothing is retained in this sweep.
          await releaseHold(work);
          await ensureSuspended(work);
          break;
        } else {
          const why = holdReasonOf(await renewalQuote(tx, row, clock));
          if (why !== null) {
            await holdRenewal(work, deps, "retain", why);
            break;
          }
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

// The scheduler's lifecycle pass (section 11). One clock reading for the whole pass. WPU-Z12: the pass
// walks EVERY candidate, page after page with a keyset cursor over (period_end, id) (candidate-walk.ts),
// until a page is short. A held subscription keeps its old period end and so stays at the head of the
// list: one page alone never reached the rows behind more than a page of held ones. Every pass starts at
// the head again; a row processed again is a replay (R7). A failure of one subscription is counted and
// logged by id and does not stop the others. A config or a page that cannot be read, or a list that does
// not move past its cursor, stops the pass (R16), after the messages of what it did were sent.
// WPU-Z12 review: the pass has an upper bound. The clock is read again before each row; once the budget
// (LIFECYCLE_BUDGET_MS) is used up no row starts, one line with the counts is logged and the pass fails with
// LifecyclePassCutError, so the jobs after it in the scheduler's run still run and its Errors alarm fires.
export async function runLifecycle(deps: LifecycleDeps): Promise<LifecycleReport> {
  const now = deps.clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("lifecycle: the clock gave no valid time");
  const pageSize = deps.pageSize ?? LIFECYCLE_LIMIT;
  const budgetMs = deps.budgetMs ?? LIFECYCLE_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError("lifecycle: the time budget must be a positive number of milliseconds");
  }
  // A time that cannot be read is past the deadline (R16): NaN is never below the budget.
  const pastDeadline = (): boolean => !(deps.clock.now().getTime() - now.getTime() < budgetMs);

  const config = await deps.runTx((tx) => readLifecycleConfig(tx));
  const horizon = Math.max(...config.reminderDays);

  const counts = { reminded: 0, renewed: 0, graced: 0, retained: 0, ended: 0, failed: 0 };
  const visit = async (id: string): Promise<void> => {
    let messages: readonly QueueMessage[] = [];
    try {
      // runTx can run its callback again: everything built here is local to one run.
      const result = await deps.runTx((tx) => process(tx, id, now, config, deps));
      if (result.step !== "none") {
        counts[result.step] += 1;
        deps.log({ event: "lifecycle", action: result.step, subscriptionId: id });
      }
      messages = result.messages;
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
    // After the row's commit and before the next row, so the deadline covers the sends too and the
    // messages of the rows done are out whenever the pass stops. sendAfterCommit never throws.
    if (deps.queue !== undefined) {
      for (const message of messages) await sendAfterCommit(deps.queue, message);
    }
  };

  const walked = await walkCandidates({
    pageSize,
    readPage: (after) =>
      deps.runTx((tx) => lifecycleRepo(tx).listCandidates(now, horizon, pageSize, after)),
    visit,
    pastDeadline,
  });
  const report: LifecycleReport = { examined: walked.visited, ...counts };
  if (!walked.complete) {
    // Counts and fixed words only (R14). The rows after the cut are candidates again on the next pass.
    deps.log({ event: "lifecycle_pass_cut", budgetMs, ...report });
    throw new LifecyclePassCutError();
  }
  return report;
}
