import {
  findLedgerTransactionByKey,
  insertOperation,
  lifecycleRepo,
  meteringRepo,
  readApprovalUntil,
  type LifecycleRow,
  type OperationKind,
  type SubscriptionStatus,
  type Tx,
  type UnpaidFlagKey,
  type UnpaidResourceRow,
} from "@tc/db";
import { retainSubscription } from "../lifecycle/engine";
import { productOfFamily, type NoticeWriter } from "../lifecycle/notice";
import { decideUnpaid, unpaidDayIndex } from "../lifecycle/unpaid";
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
import { CATCH_UP_DAYS, SNAPSHOT_METRIC, dhakaDay } from "./run";
import {
  STATIC_IP_CATCH_UP_HOURS,
  STATIC_IP_METRIC,
  STATIC_IP_MEMO,
  staticIpHoursSince,
} from "./static-ip";

// WPU-Y3. The daily job of the unpaid-usage rule (owner decision 2026-11-13, item 4).
//
// * A charge that the wallet could not pay was recorded by the normal passes (runMetering,
//   runStaticIpMetering) as `resources.config.unpaidSince`, the instant of the first failure.
// * This job looks at every resource with that mark, every run, and (1) tries every period back to the
//   first failure again, oldest first, under the SAME ledger key as the normal pass
//   (`meter:<resource>:<metric>:<period>`), so a period is charged at most once however often it is tried
//   (R7); there is no window, so no unpaid day is lost; (2) when everything is paid, ends the episode and
//   brings back what this job took away; (3) otherwise acts by `decideUnpaid`: day 0 a warning only, from
//   1 day the resource is suspended (no grace), at 7 days the subscription is retained, which queues the
//   final snapshot (where the product has one) and the destroy; the destroy waits for an admin until
//   the end date of R13 because insertOperation decides that by the same date. The destructive guard
//   still checks the subscription state and the final snapshot when the operation is claimed (R13).
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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DHAKA_OFFSET_MS = 6 * HOUR_MS;
const LIVE_STATES = ["active", "stopped", "suspended"] as const;

export function unpaidRunKey(now: Date): string {
  return `${UNPAID_RUN_PREFIX}:${dhakaDay(now)}`;
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
  hasCharge(tx: Tx, key: string): Promise<boolean>;
  post(tx: Tx, input: PostTransactionInput): Promise<Result<{ transactionId: string }>>;
  clear(tx: Tx, resourceId: string): Promise<void>;
  setFlag(tx: Tx, resourceId: string, key: UnpaidFlagKey, value: boolean): Promise<void>;
  enqueue(
    tx: Tx,
    input: { resourceId: string; kind: OperationKind; key: string; payload: unknown },
    now: Date,
  ): Promise<{ operationId: string; created: boolean; state: string }>;
  setStatus(tx: Tx, subscriptionId: string, status: SubscriptionStatus): Promise<void>;
  retain(tx: Tx, row: LifecycleRow, now: Date): Promise<QueueMessage[]>;
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
  hasCharge: async (tx, key) => (await findLedgerTransactionByKey(tx, key)) !== null,
  post: postTransaction,
  clear: (tx, resourceId) => meteringRepo(tx).clearUnpaid(resourceId),
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
  /** No price, no subscription, an unreadable mark or a family without a message word. */
  readonly blocked: number;
  readonly failed: number;
}

type Counts = { -readonly [K in keyof UnpaidReport]: UnpaidReport[K] };

const exactDate = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return !Number.isNaN(at.getTime()) && at.toISOString() === value ? at : null;
};

// The Dhaka day `back` days before the last day that ended.
function lastEndedDay(now: Date): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

type Retried = "paid" | "unpaid" | "blocked";

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

  // 1. snapshot storage: every day from the day the first failed attempt could have looked at (the
  // catch-up of the normal pass) to the last day that ended.
  const unit = await ops.snapshotUnit(tx, clock, row.market);
  const from = dhakaDay(new Date(since.getTime() - CATCH_UP_DAYS * DAY_MS));
  const to = lastEndedDay(now);
  const days = from <= to ? await ops.usage(tx, resourceId, SNAPSHOT_METRIC, from, to) : [];
  if (unit === null || unit.totalMinor <= 0n) {
    // A usage row exists but there is no price: nothing can be charged, nothing is concluded (R16).
    if (days.length > 0) return "blocked";
  } else {
    for (const day of days) {
      const key = ledgerKey.metered(resourceId, SNAPSHOT_METRIC, day.period);
      if (await ops.hasCharge(tx, key)) continue;
      const amountMinor = dailyMeteredChargeMinor(day.quantity, unit.totalMinor);
      if (amountMinor === 0n) continue;
      const posted = await ops.post(tx, {
        kind: "metered_charge",
        reference: { type: "resource", id: resourceId },
        idempotencyKey: key,
        actor: { type: "system" },
        postings: salePostings(customerId, {
          totalMinor: amountMinor,
          ...splitMeteredChargeMinor(amountMinor, unit),
        }),
      });
      if (posted.ok) {
        count.charged += 1;
        continue;
      }
      if (posted.error === "insufficient_balance") return "unpaid"; // oldest first: stop here
      return "blocked";
    }
  }

  // 2. an unattached static IP: every due hour since the hour of the first failure (minus the catch-up).
  if (config.staticIpAttached === false || config.staticIpAttached === "false") {
    const detachedAt = exactDate(config.detachedAt);
    if (detachedAt !== null) {
      const start = new Date(since.getTime() - STATIC_IP_CATCH_UP_HOURS * HOUR_MS);
      const hours = staticIpHoursSince(detachedAt, start, now);
      if (hours.length > 0) {
        const quoted = await ops.staticIpPrice(tx, clock, row.market);
        if (!quoted.ok) return "blocked";
        const price = quoted.value.perHourMinor;
        if (price > 0n) {
          for (const hour of hours) {
            const key = ledgerKey.metered(resourceId, STATIC_IP_METRIC, hour);
            if (await ops.hasCharge(tx, key)) continue;
            const posted = await ops.post(tx, {
              kind: "metered_charge",
              reference: { type: "resource", id: resourceId },
              idempotencyKey: key,
              actor: { type: "system" },
              memo: STATIC_IP_MEMO,
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
    }
  }
  return "paid";
}

interface StepOutcome {
  readonly messages: QueueMessage[];
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
  const since = exactDate(row.resource.config.unpaidSince);
  if (since === null) return blocked();

  const clock: Clock = { now: () => now };
  const retried = await retryCharges(tx, ops, row, since, now, clock, count);
  if (retried === "blocked") return blocked();

  const config = row.resource.config;
  const sinceMs = since.getTime();

  if (retried === "paid") {
    // Everything is paid: the episode ends. Only what this job did is undone (an admin's suspension
    // stays, section 11); a retained subscription goes back to active, so that the destructive guard
    // refuses any destroy that is still waiting (R13).
    if (
      config.unpaidSuspended === true &&
      config.adminSuspended !== true &&
      row.resource.state === "suspended"
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
    if (
      config.unpaidRetained === true &&
      row.status === "retained" &&
      row.resource.state !== "destroyed"
    ) {
      await ops.setStatus(tx, row.id, "active");
    }
    await ops.clear(tx, row.resourceId);
    count.paid += 1;
    return { messages };
  }

  // Still unpaid.
  count.stillUnpaid += 1;
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
    const op = await ops.enqueue(
      tx,
      {
        resourceId: row.resourceId,
        kind: "suspend",
        key: `unpaid:suspend:${row.resourceId}:${sinceMs}`,
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
        messages.push(...(await ops.retain(tx, row, now)));
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
