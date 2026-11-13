import {
  findLedgerTransactionByKey,
  lifecycleRepo,
  meteringRepo,
  readFxRates,
  type LifecycleRepo,
  type MeteringRepo,
  type Tx,
} from "@tc/db";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import { salePostings } from "../ledger/sale-postings";
import type { PostTransactionInput } from "../ledger/types";
import type { Logger, RunTx } from "../operations/types";
import { snapshotPrice } from "../products/snapshot-price";
import {
  allowanceLevel,
  dailyMeteredChargeMinor,
  splitMeteredChargeMinor,
  type MeteredUnitPrice,
} from "../pricing/metering";
import { buildChargeSnapshot, type ChargeSnapshot } from "../pricing/charge-snapshot";
import type { Clock, Result } from "../types";
import { staleWindowMs } from "./stale-window";

// Spec 11, metered items. Snapshot storage is charged once a day, one metered_charge ledger transaction
// per (resource, day) under the key `meter:<resource>:snapshot_gb:<day>`, so a repeat of any run is a
// replay (R7). Data transfer is measured by the reconciler into usage_records; this module only reads it
// and writes a notice at 80% and at 100% of the bundle allowance (notification rows, as the lifecycle
// does; nothing is sent from here). Days are Dhaka days (UTC+6, no daylight saving).

export const METERING_SETTING_KEYS = Object.freeze({
  // WPA-P2. The OLD price source: the customer price of one GB-month of snapshot storage in paisa
  // (market BD, scope market). The price source is the config row `config_price.snapshot_gb_month`
  // through the pricing engine, the one the screens show. WPU-M2: the old key is only reported (it is
  // one number with no VAT, fee or margin steps, so it cannot be split and charges nothing).
  snapshotGbMonthMinor: "metering.snapshot_gb_month_minor",
});

/**
 * WPU-M2. The market of a usage row is the market of the customer's profile (`customers.market`). The
 * launch market is only the market that is priced up front, so that a run with no usage rows still
 * reports a missing price; a row never falls back to it (an unreadable market is a failed row, R16).
 */
const DEFAULT_MARKET = "BD";
const MARKET_CODE = /^[A-Z]{2}$/;

export const SNAPSHOT_METRIC = "snapshot_gb";
export const TRANSFER_TEMPLATES = Object.freeze({
  80: "lifecycle_transfer_80",
  100: "lifecycle_transfer_100",
} as const);
export const UNPAID_TEMPLATE = "lifecycle_metered_unpaid";
/** Days before the last ended day that a run still looks at, for a run that was missed. */
export const CATCH_UP_DAYS = 2;
export const METERING_PAGE = 200;

const DHAKA_OFFSET_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of the clock in Dhaka. */
export function dhakaDay(at: Date): string {
  return new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}
export function dhakaMonth(at: Date): string {
  return dhakaDay(at).slice(0, 7);
}

type RepoPart = Pick<MeteringRepo, "listUsage" | "listTransfer"> &
  Pick<LifecycleRepo, "readSettings" | "insertNotification">;

/** The database and ledger calls, replaceable in a test. */
export interface MeteringOps {
  /**
   * The customer price of one GB-month of snapshot storage from the config row through the pricing
   * engine, with its base and steps (so a charge can be split like a purchase), or null when the market
   * has no usable one. Optional so a test world without a config price needs nothing; absent means null.
   */
  configPrice?(tx: Tx, clock: Clock, market: string): Promise<MeteredUnitPrice | null>;
  /**
   * WPU-Y1. How long the rate of the market was stale just before the rate in force took effect, in ms, while that is
   * recent (see stale-window.ts); 0 otherwise. The pass looks back that far, so a day that could not be priced while
   * the rate was older than 7 days is charged once a new rate is set. Optional: absent means 0.
   */
  staleWindowMs?(tx: Tx, clock: Clock, market: string): Promise<number>;
  repo(tx: Tx): RepoPart;
  hasCharge(tx: Tx, key: string): Promise<boolean>;
  post(tx: Tx, input: PostTransactionInput): Promise<Result<{ transactionId: string }>>;
  /**
   * WPU-Y3. Records the instant of the first failed charge of this resource (only when none is
   * recorded), so the daily unpaid job retries every period back to it, with no window. Optional so a
   * test world without it needs nothing.
   */
  markUnpaid?(
    tx: Tx,
    resourceId: string,
    at: Date,
    ipHour?: string,
    /** WPU-Y9. The Dhaka day of a failed snapshot charge; the mark keeps the oldest, the retry starts there. */
    snapshotDay?: string,
  ): Promise<void>;
  /**
   * WPU-Y3b. True when the unpaid job (`lifecycle_unpaid_enabled`) is on. It is then the single source of
   * unpaid emails, and the old `lifecycle_metered_unpaid` notice is not written. Optional: absent means off.
   */
  unpaidJobEnabled?(tx: Tx): Promise<boolean>;
}

export const defaultMeteringOps: MeteringOps = {
  configPrice: async (tx, clock, market) => {
    const priced = await snapshotPrice(tx, market, null, clock);
    return priced.ok ? priced.value.breakdown : null;
  },
  staleWindowMs: async (tx, clock, market) => {
    const now = clock.now();
    // WPU-Y9: only the rates that have started (a future row cannot push the one in force out of the list).
    const rows = await readFxRates(tx, market, 2, now);
    const [inForce, before] = rows;
    if (inForce === undefined) return 0;
    return staleWindowMs(before?.createdAt ?? null, inForce.effectiveFrom, now);
  },
  repo: (tx) => {
    const m = meteringRepo(tx);
    const l = lifecycleRepo(tx);
    return {
      listUsage: m.listUsage,
      listTransfer: m.listTransfer,
      readSettings: l.readSettings,
      insertNotification: l.insertNotification,
    };
  },
  hasCharge: async (tx, key) => (await findLedgerTransactionByKey(tx, key)) !== null,
  post: postTransaction,
  markUnpaid: (tx, resourceId, at, ipHour, snapshotDay) =>
    meteringRepo(tx).markUnpaid(resourceId, at, ipHour, snapshotDay),
  unpaidJobEnabled: async (tx) =>
    (await lifecycleRepo(tx).readSettings(["lifecycle_unpaid_enabled"])).get(
      "lifecycle_unpaid_enabled",
    ) === true,
};

export interface MeteringDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ops?: MeteringOps;
  readonly pageSize?: number;
}

export interface MeteringReport {
  readonly charged: number;
  readonly replayed: number;
  readonly skipped: number;
  readonly unpaid: number;
  readonly notified80: number;
  readonly notified100: number;
  readonly failed: number;
  readonly priceMissing: boolean;
  /**
   * Where the price of this run came from: the config row, or, when no market had one, "legacy" if only
   * the old setting is set (a number of paisa with no steps to split: it charges nothing, WPU-M2) or
   * "none".
   */
  readonly priceSource: "config" | "legacy" | "none";
}

// bigint paisa from a setting: digit text or a whole number; anything else is "no price" (R16).
function readPrice(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/**
 * WPU-Y2: the price inputs of one metered charge: the unit price's inputs, the usage, and the split of THIS
 * charge. Throws when the unit carries no inputs (R16).
 */
export function meteredSnapshot(
  unit: MeteredUnitPrice,
  metric: string,
  usage: string,
  chargeMinor: bigint,
): { priceSnapshot: ChargeSnapshot } {
  // WPU-Y9: fail closed (R16). A sale without its price inputs cannot be rebuilt later, so a unit that
  // carries none is an error, never a charge without a snapshot.
  if (unit.charge === undefined) {
    throw new RangeError("metering: the unit price carries no charge inputs (no price snapshot)");
  }
  const split = splitMeteredChargeMinor(chargeMinor, unit);
  return {
    priceSnapshot: buildChargeSnapshot("metered", unit.charge, {
      meter: { metric, usage, unitTotalMinor: unit.totalMinor.toString() },
      charge: { ...split, totalMinor: chargeMinor },
    }),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export async function runMetering(deps: MeteringDeps): Promise<MeteringReport> {
  const ops = deps.ops ?? defaultMeteringOps;
  const page = deps.pageSize ?? METERING_PAGE;
  const now = deps.clock.now();
  const count = {
    charged: 0,
    replayed: 0,
    skipped: 0,
    unpaid: 0,
    notified80: 0,
    notified100: 0,
    failed: 0,
  };
  const failRow = (what: string, error: unknown): void => {
    count.failed += 1;
    deps.log({ event: "metering_row_failed", what, error: errorName(error) });
  };

  // The price of a GB-month, with its base and steps, in the market of the customer's profile at the
  // instant of the clock (WPU-M2). A market with no usable price charges nothing (R16). Read once per
  // market and run.
  const units = new Map<string, MeteredUnitPrice | null>();
  const unitOf = async (market: string): Promise<MeteredUnitPrice | null> => {
    if (units.has(market)) return units.get(market) ?? null;
    const fromConfig: MeteredUnitPrice | null =
      ops.configPrice === undefined
        ? null
        : await deps.runTx((tx) => ops.configPrice!(tx, deps.clock, market));
    // A price of 0 paisa is no price: a free product by accident is the worse failure.
    const unit = fromConfig !== null && fromConfig.totalMinor > 0n ? fromConfig : null;
    units.set(market, unit);
    return unit;
  };
  // The launch market is priced up front: a run without usage rows still reports a missing price.
  await unitOf(DEFAULT_MARKET);

  // 1. snapshot storage: the days that ended, oldest first.
  {
    const lastEnded = new Date(now.getTime() + DHAKA_OFFSET_MS - DAY_MS);
    // WPU-Y1: days that were held while the rate was stale are charged now (launch market; replays are keyed).
    const held =
      ops.staleWindowMs === undefined
        ? 0
        : await deps.runTx((tx) => ops.staleWindowMs!(tx, deps.clock, DEFAULT_MARKET));
    const lookBack = Math.max(CATCH_UP_DAYS, Math.ceil(held / DAY_MS));
    for (let back = lookBack; back >= 0; back -= 1) {
      const day = new Date(lastEnded.getTime() - back * DAY_MS).toISOString().slice(0, 10);
      let after: string | null = null;
      for (;;) {
        const rows = await deps.runTx((tx) =>
          ops.repo(tx).listUsage(SNAPSHOT_METRIC, day, after, page),
        );
        for (const row of rows) {
          try {
            // The profile's market, checked: an unreadable one is a failed row, never the default.
            if (typeof row.market !== "string" || !MARKET_CODE.test(row.market)) {
              throw new RangeError("metering: the market of the profile is not readable");
            }
            const unit = await unitOf(row.market);
            if (unit === null) continue; // reported by priceMissing
            const outcome = await deps.runTx(async (tx) => {
              const key = ledgerKey.metered(row.resourceId, SNAPSHOT_METRIC, day);
              if (await ops.hasCharge(tx, key)) return "replayed" as const;
              const amountMinor = dailyMeteredChargeMinor(row.quantity, unit.totalMinor);
              if (amountMinor === 0n) return "skipped" as const;
              // WPU-M2 (spec 9.1: "same split as a purchase"): the base to revenue_aws_base, each VAT,
              // fee and margin step above 0 to its own account. The lines add up to the debit.
              const posted = await ops.post(tx, {
                kind: "metered_charge",
                reference: { type: "resource", id: row.resourceId },
                idempotencyKey: key,
                actor: { type: "system" },
                ...meteredSnapshot(unit, SNAPSHOT_METRIC, row.quantity, amountMinor),
                postings: salePostings(row.customerId, {
                  totalMinor: amountMinor,
                  ...splitMeteredChargeMinor(amountMinor, unit),
                }),
              });
              if (posted.ok) return "charged" as const;
              if (posted.error !== "insufficient_balance") return "failed" as const;
              // The same grace flow as a renewal (section 11) is a decision for the lifecycle owner (JOURNEY);
              // here the customer gets one notice per resource and day and the next run tries again.
              // WPU-Y3: the first failure is recorded; the unpaid job then retries every day since.
              await ops.markUnpaid?.(tx, row.resourceId, now, undefined, day);
              // WPU-Y3b: with the unpaid job on, its daily message is the only unpaid email.
              if (!((await ops.unpaidJobEnabled?.(tx)) ?? false)) {
                await ops.repo(tx).insertNotification({
                  customerId: row.customerId,
                  channel: "email",
                  template: UNPAID_TEMPLATE,
                  payload: { resourceId: row.resourceId, period: day, metric: SNAPSHOT_METRIC },
                  dedupeKey: `lifecycle:${UNPAID_TEMPLATE}:${row.resourceId}:${day}:email`,
                });
              }
              return "unpaid" as const;
            });
            count[outcome] += 1;
          } catch (error) {
            failRow("snapshot", error);
          }
        }
        if (rows.length < page) break;
        after = rows[rows.length - 1]!.id;
      }
    }
  }

  // 2. data transfer: the highest level reached this month, one notice per resource, month and level.
  const month = dhakaMonth(now);
  let afterResource: string | null = null;
  for (;;) {
    const rows = await deps.runTx((tx) => ops.repo(tx).listTransfer(month, afterResource, page));
    for (const row of rows) {
      try {
        const level = allowanceLevel(row.usedGb, row.allowanceGb);
        if (level === 0) continue;
        const template = TRANSFER_TEMPLATES[level];
        const written = await deps.runTx((tx) =>
          ops.repo(tx).insertNotification({
            customerId: row.customerId,
            channel: "email",
            template,
            payload: {
              resourceId: row.resourceId,
              period: month,
              level,
              usedGb: row.usedGb,
              allowanceGb: row.allowanceGb,
            },
            dedupeKey: `lifecycle:${template}:${row.resourceId}:${month}:email`,
          }),
        );
        if (written) count[level === 80 ? "notified80" : "notified100"] += 1;
      } catch (error) {
        failRow("transfer", error);
      }
    }
    if (rows.length < page) break;
    afterResource = rows[rows.length - 1]!.resourceId;
  }

  const priced = [...units.values()];
  const priceMissing = priced.some((u) => u === null);
  let priceSource: MeteringReport["priceSource"] = "config";
  if (!priced.some((u) => u !== null)) {
    // No market had a usable config price. The old key alone cannot charge (it has no steps to split);
    // the report only says whether it is still set, so the operator knows what to replace.
    const settings = await deps.runTx((tx) =>
      ops.repo(tx).readSettings([METERING_SETTING_KEYS.snapshotGbMonthMinor]),
    );
    priceSource =
      readPrice(settings.get(METERING_SETTING_KEYS.snapshotGbMonthMinor)) === null
        ? "none"
        : "legacy";
  }
  return { ...count, priceMissing, priceSource };
}
