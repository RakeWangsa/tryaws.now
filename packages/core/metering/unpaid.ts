import { releaseServerDisks } from "../lifecycle/attached-disks";
import {
  insertOperation,
  lifecycleRepo,
  meteringRepo,
  readApprovalUntil,
  type LifecycleRow,
  type OperationKind,
  type ResourceOpRow,
  type SubscriptionStatus,
  type Tx,
  type UnpaidFlagKey,
  type UnpaidResourceRow,
} from "@tc/db";
import { retainSubscription } from "../lifecycle/engine";
import { productOfFamily, type NoticeWriter } from "../lifecycle/notice";
import { decideUnpaid, unpaidDayIndex } from "../lifecycle/unpaid";
import { walletBalance } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import { salePostings } from "../ledger/sale-postings";
import type { PostTransactionInput } from "../ledger/types";
import {
  firstMessage,
  sendAfterCommit,
  type OperationQueue,
  type QueueMessage,
} from "../operations/queue";
import type { Logger, RunTx } from "../operations/types";
import {
  dailyMeteredChargeMinor,
  splitMeteredChargeMinor,
  type MeteredUnitPrice,
} from "../pricing/metering";
import { snapshotPrice } from "../products/snapshot-price";
import { staticIpHourPrice, type StaticIpPrice } from "../products/static-ip-price";
import type { Clock, Result } from "../types";
import { finalSnapshotUnstarted, viewDestroys, viewSuspends } from "./unpaid-undo";
import { CATCH_UP_DAYS, SNAPSHOT_METRIC, dhakaDay, meteredSnapshot } from "./run";
import {
  STATIC_IP_CATCH_UP_HOURS,
  STATIC_IP_METRIC,
  STATIC_IP_MEMO,
  staticIpHoursSince,
} from "./static-ip";

// WPU-Y3, corrected by WPU-Y3b. The daily job of the unpaid-usage rule (owner decision 2026-11-13, item 4).
//
// * A charge that the wallet could not pay was recorded by the normal passes (runMetering,
//   runStaticIpMetering) as `resources.config.unpaidSince`, the instant of the first failure, and, for a
//   static IP, the first and last failed hour (`unpaidIpFrom`, `unpaidIpTo`); for snapshot storage, the oldest
//   failed day (`unpaidDayFrom`, WPU-Y9), so a day held back during a catch-up is not lost after three days.
// * This job looks at every resource with that mark once a Dhaka day (the scheduler calls it in the first
//   minutes of 07:00, `unpaidDue`), and (1) tries every period back to the first failure again, oldest
//   first, under the SAME ledger key as the normal pass (`meter:<resource>:<metric>:<period>`), so a period
//   is charged at most once however often it is tried (R7); the charged periods are read with one query for
//   a range of keys, and at most UNPAID_PERIOD_CAP periods are charged for each resource and run (the rest
//   is next run); (2) when everything is paid, ends the episode and brings back what this job took away,
//   but resumes only a subscription that is active and not past its period end (the renewal flow owns the
//   rest); (3) otherwise acts by `decideUnpaid`: day 0 a warning only, from 1 day the resource is
//   suspended (no grace), at 7 days the subscription is retained, which queues the final snapshot (where
//   the product has one) and the destroy; the destroy waits for an admin until the end date of R13 because
//   insertOperation decides that by the same date. The destructive guard still checks the subscription
//   state and the final snapshot when the operation is claimed (R13).
// * After the retention (config.unpaidRetained) the job stops retrying while the wallet is empty; the
//   daily message goes on.
// * One message for each resource and unpaid day: the key holds the episode and the day index.
//
// The run key of a day is `unpaid:<Dhaka day>` (UNPAID_RUN_PREFIX): every effect of a run has a key of its
// own, so a second run on the same day writes and posts nothing new.
//
// A retry charges the amount of the period at the price of today (usage quantity x the current unit
// price, or the current hourly price of a static IP); a price change between the failure and the
// retry is therefore passed on (Needs decision, JOURNEY).

export const UNPAID_SETTING_KEY = "lifecycle_unpaid_enabled";
export const UNPAID_RUN_PREFIX = "unpaid";
export const UNPAID_PAGE = 200;
/** Periods (days of snapshot storage, hours of a static IP) charged for one resource in one run. */
export const UNPAID_PERIOD_CAP = 240;
/** The job runs in the first UNPAID_RUN_MINUTES minutes of this Dhaka hour. */
const UNPAID_RUN_HOUR_DHAKA = 7;
const UNPAID_RUN_MINUTES = 5;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DHAKA_OFFSET_MS = 6 * HOUR_MS;
const LIVE_STATES = ["active", "stopped", "suspended"] as const;
// Keys of one range query: well under the limit of the statement.
const KEY_WINDOW = 900;
// A static IP hour range longer than this is not a range we wrote (R16).
const MAX_MARKED_HOURS = 24 * 400;
const IP_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export function unpaidRunKey(now: Date): string {
  return `${UNPAID_RUN_PREFIX}:${dhakaDay(now)}`;
}

/**
 * WPU-Y3b. True in the first minutes of 07:00 Dhaka: the scheduler runs every minute, the job once a
 * day (a few repeats in the window are replays by the keys). Its cost does not grow with time. An
 * invalid clock is never due (R16).
 */
export function unpaidDue(now: Date): boolean {
  if (Number.isNaN(now.getTime())) return false;
  const dhaka = new Date(now.getTime() + DHAKA_OFFSET_MS);
  return (
    dhaka.getUTCHours() === UNPAID_RUN_HOUR_DHAKA && dhaka.getUTCMinutes() < UNPAID_RUN_MINUTES
  );
}

export interface UnpaidOps {
  /** The switch (settings `lifecycle_unpaid_enabled` = true). Off by default (R12, R16). */
  enabled(tx: Tx): Promise<boolean>;
  approvalUntil(tx: Tx): Promise<Date | null>;
  list(tx: Tx, afterId: string | null, limit: number): Promise<UnpaidResourceRow[]>;
  lock(tx: Tx, subscriptionId: string): Promise<LifecycleRow | null>;
  usage(
    tx: Tx,
    resourceId: string,
    metric: string,
    from: string,
    to: string,
  ): Promise<{ period: string; quantity: string }[]>;
  snapshotUnit(tx: Tx, clock: Clock, market: string): Promise<MeteredUnitPrice | null>;
  staticIpPrice(tx: Tx, clock: Clock, market: string): Promise<Result<StaticIpPrice>>;
  /** The periods from `from` to `to` (inclusive) of this metric that already have a charge: one query. */
  chargedPeriods(
    tx: Tx,
    resourceId: string,
    metric: string,
    from: string,
    to: string,
  ): Promise<Set<string>>;
  /** The wallet balance of the customer (paisa). */
  balance(tx: Tx, customerId: string): Promise<bigint>;
  post(tx: Tx, input: PostTransactionInput): Promise<Result<{ transactionId: string }>>;
  clear(tx: Tx, resourceId: string): Promise<void>;
  /**
   * WPU-Y9. Starts the unpaid clock (`unpaidSince`) of a resource that had only held hours, at the first
   * charge that failed for `insufficient_balance`. Optional: absent means a world without it.
   */
  startClock?(tx: Tx, resourceId: string, at: Date): Promise<void>;
  setFlag(
    tx: Tx,
    resourceId: string,
    key: UnpaidFlagKey,
    value: boolean | "active" | "grace",
  ): Promise<void>;
  enqueue(
    tx: Tx,
    input: { resourceId: string; kind: OperationKind; key: string; payload: unknown },
    now: Date,
  ): Promise<{ operationId: string; created: boolean; state: string }>;
  setStatus(tx: Tx, subscriptionId: string, status: SubscriptionStatus): Promise<void>;
  retain(tx: Tx, row: LifecycleRow, now: Date, episode?: number): Promise<QueueMessage[]>;
  /** Final snapshots of the resource stop being final (a restore ends the retention); returns their ids. */
  supersedeFinal(tx: Tx, resourceId: string): Promise<string[]>;
  /** WPU-Y3c. The operations of the resource of these kinds, oldest first. */
  resourceOps(tx: Tx, resourceId: string, kinds: readonly string[]): Promise<ResourceOpRow[]>;
  /**
   * WPU-Y3c. The system-level cancel: a queued (or unapproved, waiting) operation that has not started
   * becomes `failed`. False when it was already claimed, approved or over.
   */
  cancel(tx: Tx, operationId: string): Promise<boolean>;
  /**
   * WPU-Y4 fix round 2. A server that leaves `retained` gives the disks retained with it their status back
   * (releaseServerDisks). Optional: absent means a world without it.
   */
  releaseDisks?(tx: Tx, row: LifecycleRow, log?: Logger): Promise<void>;
}

export const defaultUnpaidOps: UnpaidOps = {
  enabled: async (tx) =>
    (await lifecycleRepo(tx).readSettings([UNPAID_SETTING_KEY])).get(UNPAID_SETTING_KEY) === true,
  approvalUntil: (tx) => readApprovalUntil(tx),
  list: (tx, afterId, limit) => meteringRepo(tx).listUnpaidResources(afterId, limit),
  lock: (tx, subscriptionId) => lifecycleRepo(tx).lock(subscriptionId),
  usage: (tx, resourceId, metric, from, to) =>
    meteringRepo(tx).usageOfResource(resourceId, metric, from, to),
  snapshotUnit: async (tx, clock, market) => {
    const priced = await snapshotPrice(tx, market, null, clock);
    return priced.ok ? priced.value.breakdown : null;
  },
  staticIpPrice: (tx, clock, market) => staticIpHourPrice(tx, market, clock),
  chargedPeriods: async (tx, resourceId, metric, from, to) => {
    const lo = ledgerKey.metered(resourceId, metric, from);
    const hi = ledgerKey.metered(resourceId, metric, to);
    const prefix = lo.slice(0, lo.length - from.length);
    const keys = await meteringRepo(tx).chargedKeys(prefix, lo, hi, 1000);
    return new Set(keys.map((k) => k.slice(prefix.length)));
  },
  balance: (tx, customerId) => walletBalance(tx, customerId),
  post: postTransaction,
  clear: (tx, resourceId) => meteringRepo(tx).clearUnpaid(resourceId),
  startClock: (tx, resourceId, at) => meteringRepo(tx).markUnpaid(resourceId, at),
  setFlag: (tx, resourceId, key, value) => meteringRepo(tx).setUnpaidFlag(resourceId, key, value),
  enqueue: async (tx, input, now) => {
    const inserted = await insertOperation(
      tx,
      {
        resourceId: input.resourceId,
        kind: input.kind,
        payload: input.payload,
        idempotencyKey: input.key,
      },
      now,
    );
    return { operationId: inserted.operationId, created: inserted.created, state: inserted.state };
  },
  setStatus: (tx, subscriptionId, status) => lifecycleRepo(tx).setStatus(subscriptionId, status),
  retain: retainSubscription,
  supersedeFinal: (tx, resourceId) => meteringRepo(tx).supersedeFinalBackups(resourceId),
  resourceOps: (tx, resourceId, kinds) => meteringRepo(tx).operationsOf(resourceId, kinds),
  cancel: (tx, operationId) => meteringRepo(tx).cancelUnstarted(operationId),
  releaseDisks: async (tx, row, log) => {
    if (row.resource.family !== "linux_instance" && row.resource.family !== "windows_instance")
      return;
    await releaseServerDisks(tx, { customerId: row.customerId, serverId: row.resourceId }, log);
  },
};

export interface UnpaidDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  /** With a queue the new operations are sent after the commit; else the sweeper sends them (3.4). */
  readonly queue?: OperationQueue;
  readonly notice?: NoticeWriter;
  readonly ops?: UnpaidOps;
  readonly pageSize?: number;
}

export interface UnpaidReport {
  readonly runKey: string;
  readonly enabled: boolean;
  readonly examined: number;
  /** Periods charged by this run (a retry that now succeeded). */
  readonly charged: number;
  /** Resources whose every unpaid charge is now paid. */
  readonly paid: number;
  readonly resumed: number;
  readonly suspended: number;
  readonly retained: number;
  readonly noticed: number;
  readonly stillUnpaid: number;
  /** Resources that hit UNPAID_PERIOD_CAP in this run; the rest is next run. */
  readonly capped: number;
  /** Resources after the retention with an empty wallet: no retry was made. */
  readonly skipped: number;
  /** WPU-Y3c. Suspends of the job itself that had not started and were cancelled by a payment. */
  readonly suspendsCancelled: number;
  /** WPU-Y3c. Final snapshots that stopped being final after a payment (the customer may delete them). */
  readonly finalReleased: number;
  /** WPU-Y3c. Resources whose final snapshot stays final because a destroy ran, is approved or is unclear. */
  readonly finalHeld: number;
  /** No price, no subscription, an unreadable mark or a family without a message word. */
  readonly blocked: number;
  readonly failed: number;
}

type Counts = { -readonly [K in keyof UnpaidReport]: UnpaidReport[K] };

const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const exactDate = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.toISOString() === value ? at : null;
};

// The Dhaka day `back` days before the last day that ended.
function lastEndedDay(now: Date): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

const hourStart = (hour: string): number => Date.parse(`${hour}:00:00+06:00`);
const hourName = (ms: number): string => new Date(ms + DHAKA_OFFSET_MS).toISOString().slice(0, 13);

// The hours from `from` to `to` (Dhaka hour names), or null when the pair cannot be read (R16).
function hoursBetween(from: unknown, to: unknown): string[] | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!IP_HOUR.test(from) || !IP_HOUR.test(to)) return null;
  const a = hourStart(from);
  const b = hourStart(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  if ((b - a) / HOUR_MS + 1 > MAX_MARKED_HOURS) return null;
  const out: string[] = [];
  for (let t = a; t <= b; t += HOUR_MS) out.push(hourName(t));
  return out;
}

/**
 * The periods of `periods` (sorted, oldest first) that have no charge yet: at most `limit` of them, and
 * whether there are more. The charged ones are read with one range query for each window of
 * KEY_WINDOW periods, not one lookup for each period.
 */
async function pendingPeriods(
  tx: Tx,
  ops: UnpaidOps,
  resourceId: string,
  metric: string,
  periods: readonly string[],
  limit: number,
): Promise<{ pending: string[]; more: boolean }> {
  const pending: string[] = [];
  let more = false;
  for (let at = 0; at < periods.length && !more; at += KEY_WINDOW) {
    const window = periods.slice(at, at + KEY_WINDOW);
    const charged = await ops.chargedPeriods(
      tx,
      resourceId,
      metric,
      window[0]!,
      window[window.length - 1]!,
    );
    for (const period of window) {
      if (charged.has(period)) continue;
      if (pending.length >= limit) {
        more = true;
        break;
      }
      pending.push(period);
    }
  }
  return { pending, more };
}

type Retried = "paid" | "unpaid" | "blocked" | "capped";

async function retryCharges(
  tx: Tx,
  ops: UnpaidOps,
  row: LifecycleRow,
  since: Date,
  now: Date,
  clock: Clock,
  count: Counts,
): Promise<Retried> {
  const { resourceId, customerId } = { resourceId: row.resourceId, customerId: row.customerId };
  const config = row.resource.config;
  let budget = UNPAID_PERIOD_CAP;

  // 1. snapshot storage: every day from the day the first failed attempt could have looked at (the
  // catch-up of the normal pass) to the last day that ended.
  const unit = await ops.snapshotUnit(tx, clock, row.market);
  // WPU-Y9: the oldest failed snapshot day kept in the mark (a day held back during a catch-up can be older
  // than the catch-up before the first failure). An unreadable day refuses the retry (R16).
  const normal = dhakaDay(new Date(since.getTime() - CATCH_UP_DAYS * DAY_MS));
  const markedDay = config.unpaidDayFrom;
  if (markedDay !== undefined && (typeof markedDay !== "string" || !DAY_NAME.test(markedDay))) {
    return "blocked";
  }
  const from = typeof markedDay === "string" && markedDay < normal ? markedDay : normal;
  const to = lastEndedDay(now);
  const days = from <= to ? await ops.usage(tx, resourceId, SNAPSHOT_METRIC, from, to) : [];
  if (unit === null || unit.totalMinor <= 0n) {
    // A usage row exists but there is no price: nothing can be charged, nothing is concluded (R16).
    if (days.length > 0) return "blocked";
  } else if (days.length > 0) {
    const quantity = new Map(days.map((d) => [d.period, d.quantity]));
    const { pending, more } = await pendingPeriods(
      tx,
      ops,
      resourceId,
      SNAPSHOT_METRIC,
      days.map((d) => d.period),
      budget,
    );
    for (const period of pending) {
      const amountMinor = dailyMeteredChargeMinor(quantity.get(period)!, unit.totalMinor);
      if (amountMinor === 0n) continue;
      const posted = await ops.post(tx, {
        kind: "metered_charge",
        reference: { type: "resource", id: resourceId },
        idempotencyKey: ledgerKey.metered(resourceId, SNAPSHOT_METRIC, period),
        actor: { type: "system" },
        ...meteredSnapshot(unit, SNAPSHOT_METRIC, quantity.get(period)!, amountMinor),
        postings: salePostings(customerId, {
          totalMinor: amountMinor,
          ...splitMeteredChargeMinor(amountMinor, unit),
        }),
      });
      if (posted.ok) {
        count.charged += 1;
        budget -= 1;
        continue;
      }
      if (posted.error === "insufficient_balance") return "unpaid"; // oldest first: stop here
      return "blocked";
    }
    if (more) return "capped";
  }

  // 2. a static IP: the hours that failed (the range kept in the mark, whatever the attach state is by
  // now) and, while it is unattached, every due hour since the hour of the first failure.
  const hours = new Set<string>();
  if (config.unpaidIpFrom !== undefined || config.unpaidIpTo !== undefined) {
    const marked = hoursBetween(config.unpaidIpFrom, config.unpaidIpTo);
    if (marked === null) return "blocked";
    for (const h of marked) hours.add(h);
  }
  if (config.staticIpAttached === false || config.staticIpAttached === "false") {
    const detachedAt = exactDate(config.detachedAt);
    if (detachedAt !== null) {
      const start = new Date(since.getTime() - STATIC_IP_CATCH_UP_HOURS * HOUR_MS);
      for (const h of staticIpHoursSince(detachedAt, start, now)) hours.add(h);
    }
  }
  if (hours.size > 0) {
    const sorted = [...hours].sort();
    const { pending, more } = await pendingPeriods(
      tx,
      ops,
      resourceId,
      STATIC_IP_METRIC,
      sorted,
      budget,
    );
    if (pending.length > 0) {
      const quoted = await ops.staticIpPrice(tx, clock, row.market);
      if (!quoted.ok) return "blocked";
      const price = quoted.value.perHourMinor;
      if (price > 0n) {
        for (const hour of pending) {
          const posted = await ops.post(tx, {
            kind: "metered_charge",
            reference: { type: "resource", id: resourceId },
            idempotencyKey: ledgerKey.metered(resourceId, STATIC_IP_METRIC, hour),
            actor: { type: "system" },
            memo: STATIC_IP_MEMO,
            ...meteredSnapshot(quoted.value.breakdown, STATIC_IP_METRIC, "1", price),
            postings: salePostings(customerId, {
              totalMinor: price,
              ...splitMeteredChargeMinor(price, quoted.value.breakdown),
            }),
          });
          if (posted.ok) {
            count.charged += 1;
            continue;
          }
          if (posted.error === "insufficient_balance") return "unpaid";
          return "blocked";
        }
      }
    }
    if (more) return "capped";
  }
  return "paid";
}

interface StepOutcome {
  readonly messages: QueueMessage[];
}

/**
 * WPU-Y3c (R13). After a payment that came after the retention: the final snapshot stops being final
 * only when the retention destroy is confirmed not to have run. Every destroy operation of the resource
 * (plain key and episode-salted key alike) is read; one that is running, done, stuck, approved or failed
 * after it ran stops everything, and so does a resource that is not live. A destroy that has not started
 * (queued, or waiting for an approval nobody gave) is cancelled first, and every cancel must succeed.
 * Nothing is deleted here: the former final snapshot becomes an ordinary backup that the customer (or an
 * admin, with approval until the R13 date) deletes; no `delete_backup` is queued by this job.
 */
async function releaseFinalSnapshots(
  tx: Tx,
  ops: UnpaidOps,
  deps: UnpaidDeps,
  row: LifecycleRow,
  count: Counts,
  sinceMs: number,
): Promise<void> {
  const held = (reason: string): void => {
    count.finalHeld += 1;
    deps.log({ event: "unpaid", action: "final_held", reason, resourceId: row.resourceId });
  };
  const live =
    (LIVE_STATES as readonly string[]).includes(row.resource.state) &&
    row.resource.deletedAt === null;
  if (!live) return held("not_live");
  const view = viewDestroys(await ops.resourceOps(tx, row.resourceId, ["destroy"]));
  if (!view.safe) return held("destroy_started_or_approved");
  for (const op of view.toCancel) {
    if (!(await ops.cancel(tx, op.id))) return held("destroy_not_cancelled");
  }
  // WPU-X1: the retention is over, so its final snapshot that never started is ended (it would make a snapshot
  // that nobody asked for, billed every day). One that started (or whose cancel loses the race with a claim)
  // finishes: its backup is an ordinary one (superseded below, or not final from the start when its row comes
  // after this commit: ensureFinalBackup of @tc/db). Ids and fixed words only in the log (R14).
  for (const op of await ops.resourceOps(tx, row.resourceId, ["final_snapshot"])) {
    if (!finalSnapshotUnstarted(op)) continue;
    if (await ops.cancel(tx, op.id)) {
      deps.log({
        event: "unpaid",
        action: "final_snapshot_ended",
        resourceId: row.resourceId,
        operationId: op.id,
      });
    }
  }
  const released = (await ops.supersedeFinal(tx, row.resourceId)).length;
  count.finalReleased += released;
  // WPU-Y10: the customer is told once for each resource and episode that the former final snapshot is an
  // ordinary backup now, billed every day until it is deleted. Wording approved by the owner on 2026-11-13 (@tc/notify).
  const product = productOfFamily(row.resource.family);
  if (released > 0 && deps.notice !== undefined && product !== null) {
    await deps.notice(tx, {
      customerId: row.customerId,
      template: "unpaid_snapshot_released",
      data: { resourceId: row.resourceId, product },
      dedupeKey: `unpaid:final-released:${row.resourceId}:${sinceMs}`,
    });
    count.noticed += 1;
  }
}

async function processOne(
  tx: Tx,
  ops: UnpaidOps,
  deps: UnpaidDeps,
  listed: UnpaidResourceRow,
  now: Date,
  count: Counts,
): Promise<StepOutcome> {
  const messages: QueueMessage[] = [];
  const blocked = (): StepOutcome => {
    count.blocked += 1;
    return { messages };
  };
  // R16: a resource with no subscription cannot be retained, and an unreadable mark decides nothing.
  if (listed.subscriptionId === null) return blocked();
  const row = await ops.lock(tx, listed.subscriptionId);
  if (row === null || row.resourceId !== listed.resourceId) return blocked();
  if (!(LIVE_STATES as readonly string[]).includes(row.resource.state)) return { messages };
  const markedSince = exactDate(row.resource.config.unpaidSince);
  // WPU-Y9: held hours without the clock (a stale rate kept them). They are retried like unpaid periods,
  // but nobody is near suspension or deletion until a charge fails for insufficient_balance.
  const held =
    markedSince === null &&
    row.resource.config.unpaidSince === undefined &&
    row.resource.config.unpaidIpFrom !== undefined;
  if (markedSince === null && !held) return blocked();
  const since = markedSince ?? now;

  const clock: Clock = { now: () => now };
  const config = row.resource.config;
  const sinceMs = since.getTime(); // for a held resource this is now: day 0, the clock starts below

  // After the retention nothing is retried while the wallet is empty (a payment is what ends the wait).
  let retried: Retried;
  if (config.unpaidRetained === true && (await ops.balance(tx, row.customerId)) <= 0n) {
    count.skipped += 1;
    retried = "unpaid";
  } else {
    retried = await retryCharges(tx, ops, row, since, now, clock, count);
  }
  if (retried === "blocked") return blocked();
  if (held && retried !== "paid") {
    // Nothing failed for a short wallet yet, only the cap of this run: the rest is next run, no clock.
    if (retried === "capped") {
      count.capped += 1;
      return { messages };
    }
    // The first insufficient_balance result: the clock starts now (day 0, a warning only).
    await ops.startClock?.(tx, row.resourceId, now);
  }

  if (retried === "paid") {
    // Everything is paid: the episode ends. Only what this job did is undone (an admin's suspension
    // stays, section 11).
    let status: SubscriptionStatus = row.status;
    if (config.unpaidRetained === true && row.status === "retained") {
      // Back to the status it had before the job retained it, so that the destructive guard refuses any
      // destroy that is still waiting (R13) and the renewal flow goes on where it was. Unreadable: grace.
      status = config.unpaidRetainedFrom === "active" ? "active" : "grace";
      await ops.setStatus(tx, row.id, status);
      await releaseFinalSnapshots(tx, ops, deps, row, count, sinceMs);
      // WPU-Y4 fix round 2: the disks retained with the server are given back in the same transaction.
      await ops.releaseDisks?.(tx, row, deps.log);
    }
    // WPU-Y3c. A suspend of the job that has not started is CANCELLED, not answered with a blind resume
    // (the review found that a resume could lift an admin's suspension queued in the meantime). A resume
    // is queued only when the job's own suspend has started or ran, or the resource is suspended; it
    // needs an active subscription with a period end in the future (finding 1) and no other suspend of
    // the resource that is open, or done and not resumed (admin abuse, lifecycle, unknown: R16). It
    // runs after the suspend (the provisioner takes the operations of a resource in the order they
    // were created).
    const state = row.resource.state;
    const subscriptionOk = status === "active" && row.periodEnd.getTime() > now.getTime();
    if (config.unpaidSuspended === true || state === "suspended") {
      const view = viewSuspends(
        await ops.resourceOps(tx, row.resourceId, ["suspend", "resume"]),
        row.resourceId,
      );
      let ownLeft = view.ownInFlightOrDone;
      for (const op of view.cancellable) {
        if (await ops.cancel(tx, op.id)) count.suspendsCancelled += 1;
        else ownLeft = true; // it started in the meantime: the resume has to follow it
      }
      if (
        config.adminSuspended !== true &&
        subscriptionOk &&
        !view.foreignHolds &&
        (state === "suspended" || ownLeft)
      ) {
        const resume = await ops.enqueue(
          tx,
          {
            resourceId: row.resourceId,
            kind: "resume",
            key: `unpaid:resume:${row.resourceId}:${sinceMs}`,
            payload: { subscriptionId: row.id },
          },
          now,
        );
        if (resume.created && resume.state === "queued") {
          messages.push(firstMessage(resume.operationId, row.resourceId));
        }
        count.resumed += 1;
      }
    }
    await ops.clear(tx, row.resourceId);
    count.paid += 1;
    return { messages };
  }

  // Still unpaid (or the cap of this run was reached: the rest is next run).
  count.stillUnpaid += 1;
  if (retried === "capped") count.capped += 1;
  const approvalUntil = await ops.approvalUntil(tx);
  const stage = decideUnpaid({ unpaidSince: since, now, approvalUntil });
  const index = unpaidDayIndex(since, now);
  const product = productOfFamily(row.resource.family);
  const notice = async (
    template: "unpaid_warning" | "unpaid_suspended" | "unpaid_deletion",
    data: Record<string, unknown>,
  ): Promise<void> => {
    if (deps.notice === undefined || product === null) return;
    await deps.notice(tx, {
      customerId: row.customerId,
      template,
      data: { resourceId: row.resourceId, product, ...data },
      dedupeKey: `unpaid:${row.resourceId}:${sinceMs}:${index}`,
    });
    count.noticed += 1;
  };

  const ensureSuspended = async (): Promise<void> => {
    if (row.resource.state !== "active" && row.resource.state !== "stopped") return;
    // The key holds the unpaid day: a resource that was resumed in the same episode (an admin, say) is
    // suspended again on the next unpaid day, and a repeat of the run on one day is a replay (R7).
    const op = await ops.enqueue(
      tx,
      {
        resourceId: row.resourceId,
        kind: "suspend",
        key: `unpaid:suspend:${row.resourceId}:${sinceMs}:${index}`,
        payload: { subscriptionId: row.id },
      },
      now,
    );
    if (op.created && op.state === "queued") {
      messages.push(firstMessage(op.operationId, row.resourceId));
    }
    if (config.unpaidSuspended !== true) {
      await ops.setFlag(tx, row.resourceId, "unpaidSuspended", true);
      count.suspended += 1;
    }
  };

  switch (stage.stage) {
    case "none":
      return blocked();
    case "retry":
      // Day 0: only a warning. The price of the charge is not in it; the panel shows it.
      await notice("unpaid_warning", {});
      return { messages };
    case "suspended":
      await ensureSuspended();
      await notice("unpaid_suspended", {
        daysLeft: stage.daysLeft,
        deleteAt: stage.deleteAt.toISOString(),
      });
      return { messages };
    case "deletion": {
      await ensureSuspended();
      // Only an active or grace subscription is retained; retained already means the operations exist
      // (the engine's own pass keeps them); ended has nothing left to do.
      if (row.status === "active" || row.status === "grace") {
        // The status to return to when the customer pays, and the episode for the operation keys.
        await ops.setFlag(tx, row.resourceId, "unpaidRetainedFrom", row.status);
        messages.push(...(await ops.retain(tx, row, now, sinceMs)));
        await ops.setFlag(tx, row.resourceId, "unpaidRetained", true);
        count.retained += 1;
      }
      await notice("unpaid_deletion", {
        deleteAt: stage.deleteAt.toISOString(),
        approval: stage.approvalRequired,
      });
      return { messages };
    }
  }
}

export async function runUnpaid(deps: UnpaidDeps): Promise<UnpaidReport> {
  const ops = deps.ops ?? defaultUnpaidOps;
  const page = deps.pageSize ?? UNPAID_PAGE;
  const now = deps.clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("unpaid: the clock gave no valid time");
  const count: Counts = {
    runKey: unpaidRunKey(now),
    enabled: false,
    examined: 0,
    charged: 0,
    paid: 0,
    resumed: 0,
    suspended: 0,
    retained: 0,
    noticed: 0,
    stillUnpaid: 0,
    capped: 0,
    skipped: 0,
    suspendsCancelled: 0,
    finalReleased: 0,
    finalHeld: 0,
    blocked: 0,
    failed: 0,
  };
  // R12/R16: off unless the switch says true; a switch that cannot be read is off.
  count.enabled = await deps.runTx((tx) => ops.enabled(tx));
  if (!count.enabled) return count;

  const outbox: QueueMessage[] = [];
  let after: string | null = null;
  for (;;) {
    const rows: UnpaidResourceRow[] = await deps.runTx((tx) => ops.list(tx, after, page));
    for (const listed of rows) {
      count.examined += 1;
      // Counts of a transaction that is run again are rolled back with it: work on a copy.
      const local: Counts = { ...count };
      try {
        const result = await deps.runTx((tx) => {
          Object.assign(local, count);
          return processOne(tx, ops, deps, listed, now, local);
        });
        Object.assign(count, local);
        outbox.push(...result.messages);
      } catch (error) {
        count.failed += 1;
        // The name of the error and the id, never its message or its data (R14).
        deps.log({
          event: "unpaid",
          action: "error",
          resourceId: listed.resourceId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (rows.length < page) break;
    after = rows[rows.length - 1]!.resourceId;
  }
  if (deps.queue !== undefined) {
    for (const message of outbox) await sendAfterCommit(deps.queue, message);
  }
  return count;
}
