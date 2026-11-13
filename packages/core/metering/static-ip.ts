import {
  findLedgerTransactionByKey,
  lifecycleRepo,
  meteringRepo,
  type DetachedIpRow,
  type NewLifecycleNotification,
  type Tx,
} from "@tc/db";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import { salePostings } from "../ledger/sale-postings";
import { splitMeteredChargeMinor } from "../pricing/metering";
import type { PostTransactionInput } from "../ledger/types";
import type { Logger, RunTx } from "../operations/types";
import { staticIpHourPrice, type StaticIpPrice } from "../products/static-ip-price";
import type { Clock, Result } from "../types";
import { UNPAID_TEMPLATE, dhakaDay } from "./run";

// WPU-M1. A static IP that is not attached to a server is charged as Amazon Lightsail does: free while
// attached, and USD 0.005 an hour (config price, converted by the pricing engine) once it has been
// unattached for MORE than one hour. The posting is the existing metered_charge of snapshot storage
// (WPU-M2: split like a purchase, spec 9.1: the wallet debit, revenue_aws_base for the base and one
// credit per VAT, fee or margin step above 0); only the metric and the memo are new. One charge per IP and
// hour bucket under `meter:<resource>:static_ip_hour:<YYYY-MM-DDTHH>` (R7). Hours are Dhaka hours.

export const STATIC_IP_METRIC = "static_ip_hour";
export const STATIC_IP_MEMO = "static_ip_unattached";
export const STATIC_IP_NOTICE_PREFIX = "static_ip";
export const STATIC_IP_FREE_MS = 3_600_000;
/** Hours before the current one that a run still looks at, for a run that was missed. */
export const STATIC_IP_CATCH_UP_HOURS = 2;
export const STATIC_IP_PAGE = 200;

const HOUR_MS = 3_600_000;
const DHAKA_OFFSET_MS = 6 * HOUR_MS;

/** `YYYY-MM-DDTHH` of the clock in Dhaka. */
export function dhakaHour(at: Date): string {
  return new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 13);
}

/**
 * The hour buckets that are due for an IP detached at `detachedAt`, oldest first: the current Dhaka hour
 * and up to two before it. A bucket is due when the IP had been detached for MORE than one hour at the
 * earlier of `now` and the end of the bucket. At exactly one hour nothing is due.
 */
export function staticIpChargeableHours(detachedAt: Date, now: Date): string[] {
  const start = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return staticIpHoursSince(detachedAt, new Date(start - STATIC_IP_CATCH_UP_HOURS * HOUR_MS), now);
}

/**
 * WPU-Y3. Every hour bucket that is due from the Dhaka hour of `from` to the current one, oldest first,
 * by the same rule as above (MORE than one hour detached at the earlier of `now` and the end of the
 * bucket). The retry of an unpaid charge starts at the hour of the first failed charge, so no hour is
 * lost to the three-hour window of the normal pass.
 */
export function staticIpHoursSince(detachedAt: Date, from: Date, now: Date): string[] {
  const out: string[] = [];
  const nowMs = now.getTime();
  const fromMs = from.getTime();
  const detachedMs = detachedAt.getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(fromMs) || Number.isNaN(detachedMs)) return out;
  const end = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  for (
    let bucketStart = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
    bucketStart <= end;
    bucketStart += HOUR_MS
  ) {
    const horizon = Math.min(nowMs, bucketStart + HOUR_MS);
    if (detachedMs + STATIC_IP_FREE_MS < horizon) out.push(dhakaHour(new Date(bucketStart)));
  }
  return out;
}

/** True once an IP detached at `detachedAt` has been unattached for MORE than one hour at `now`. */
export function staticIpIsCharging(detachedAt: Date, now: Date): boolean {
  return detachedAt.getTime() + STATIC_IP_FREE_MS < now.getTime();
}

export interface StaticIpOps {
  list(tx: Tx, afterId: string | null, limit: number): Promise<DetachedIpRow[]>;
  price(tx: Tx, market: string, clock: Clock): Promise<Result<StaticIpPrice>>;
  hasCharge(tx: Tx, key: string): Promise<boolean>;
  post(tx: Tx, input: PostTransactionInput): Promise<Result<{ transactionId: string }>>;
  notify(tx: Tx, notice: NewLifecycleNotification): Promise<boolean>;
  /**
   * WPU-Y3. Records the instant of the first failed charge of this resource (only when none is
   * recorded), so the daily unpaid job retries every period back to it. Optional so a test world
   * without it needs nothing.
   */
  markUnpaid?(tx: Tx, resourceId: string, at: Date): Promise<void>;
}

export const defaultStaticIpOps: StaticIpOps = {
  list: (tx, afterId, limit) => meteringRepo(tx).listDetachedStaticIps(afterId, limit),
  price: staticIpHourPrice,
  hasCharge: async (tx, key) => (await findLedgerTransactionByKey(tx, key)) !== null,
  post: postTransaction,
  notify: (tx, notice) => lifecycleRepo(tx).insertNotification(notice),
  markUnpaid: (tx, resourceId, at) => meteringRepo(tx).markUnpaid(resourceId, at),
};

export interface StaticIpMeteringDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ops?: StaticIpOps;
  readonly pageSize?: number;
}

export interface StaticIpReport {
  readonly charged: number;
  readonly replayed: number;
  readonly skipped: number;
  readonly unpaid: number;
  readonly notDue: number;
  readonly noTimestamp: number;
  readonly failed: number;
  readonly priceMissing: boolean;
}

export async function runStaticIpMetering(deps: StaticIpMeteringDeps): Promise<StaticIpReport> {
  const ops = deps.ops ?? defaultStaticIpOps;
  const page = deps.pageSize ?? STATIC_IP_PAGE;
  const now = deps.clock.now();
  const count = {
    charged: 0,
    replayed: 0,
    skipped: 0,
    unpaid: 0,
    notDue: 0,
    noTimestamp: 0,
    failed: 0,
  };
  let priceMissing = false;
  const prices = new Map<string, StaticIpPrice | null>();

  const priceOf = async (market: string): Promise<StaticIpPrice | null> => {
    if (prices.has(market)) return prices.get(market) ?? null;
    const found = await deps.runTx((tx) => ops.price(tx, market, deps.clock));
    const value = found.ok ? found.value : null;
    prices.set(market, value);
    if (value === null) priceMissing = true;
    return value;
  };

  let after: string | null = null;
  for (;;) {
    const rows: DetachedIpRow[] = await deps.runTx((tx) => ops.list(tx, after, page));
    for (const row of rows) {
      try {
        if (row.detachedAt === null) {
          count.noTimestamp += 1;
          deps.log({ event: "static_ip_no_timestamp", resourceId: row.resourceId });
          continue;
        }
        const hours = staticIpChargeableHours(row.detachedAt, now);
        if (hours.length === 0) {
          count.notDue += 1;
          continue;
        }
        const quoted = await priceOf(row.market);
        if (quoted === null) continue;
        const price = quoted.perHourMinor;
        const breakdown = quoted.breakdown;
        if (price === 0n) {
          count.skipped += 1;
          continue;
        }
        for (const hour of hours) {
          const outcome = await deps.runTx(async (tx) => {
            const key = ledgerKey.metered(row.resourceId, STATIC_IP_METRIC, hour);
            if (await ops.hasCharge(tx, key)) return "replayed" as const;
            const posted = await ops.post(tx, {
              kind: "metered_charge",
              reference: { type: "resource", id: row.resourceId },
              idempotencyKey: key,
              actor: { type: "system" },
              memo: STATIC_IP_MEMO,
              // WPU-M2: the split of a purchase (spec 9.1), from the steps of the engine's quote.
              postings: salePostings(row.customerId, {
                totalMinor: price,
                ...splitMeteredChargeMinor(price, breakdown),
              }),
            });
            if (posted.ok) return "charged" as const;
            if (posted.error !== "insufficient_balance") return "failed" as const;
            // The snapshot behaviour: nothing is posted, one notice for each resource and day, and the
            // next run tries again. The wallet is never taken below zero (R16).
            await ops.markUnpaid?.(tx, row.resourceId, now);
            await ops.notify(tx, {
              customerId: row.customerId,
              channel: "email",
              template: UNPAID_TEMPLATE,
              payload: { resourceId: row.resourceId, period: hour, metric: STATIC_IP_METRIC },
              dedupeKey: `lifecycle:${UNPAID_TEMPLATE}:${row.resourceId}:${STATIC_IP_NOTICE_PREFIX}:${dhakaDay(now)}:email`,
            });
            return "unpaid" as const;
          });
          count[outcome] += 1;
        }
      } catch (error) {
        count.failed += 1;
        deps.log({
          event: "metering_row_failed",
          what: "static_ip",
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (rows.length < page) break;
    after = rows[rows.length - 1]!.resourceId;
  }
  return { ...count, priceMissing };
}
