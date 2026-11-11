import {
  findLedgerTransactionByKey,
  lifecycleRepo,
  meteringRepo,
  type LifecycleRepo,
  type MeteringRepo,
  type Tx,
} from "@tc/db";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import type { PostTransactionInput } from "../ledger/types";
import type { Logger, RunTx } from "../operations/types";
import { allowanceLevel, dailyMeteredChargeMinor } from "../pricing/metering";
import type { Clock, Result } from "../types";

// Spec 11, metered items. Snapshot storage is charged once a day, one metered_charge ledger transaction
// per (resource, day) under the key `meter:<resource>:snapshot_gb:<day>`, so a repeat of any run is a
// replay (R7). Data transfer is measured by the reconciler into usage_records; this module only reads it
// and writes a notice at 80% and at 100% of the bundle allowance (notification rows, as the lifecycle
// does; nothing is sent from here). Days are Dhaka days (UTC+6, no daylight saving).

export const METERING_SETTING_KEYS = Object.freeze({
  // Customer price of one GB-month of snapshot storage in paisa (market BD, scope market).
  snapshotGbMonthMinor: "metering.snapshot_gb_month_minor",
});

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
  repo(tx: Tx): RepoPart;
  hasCharge(tx: Tx, key: string): Promise<boolean>;
  post(tx: Tx, input: PostTransactionInput): Promise<Result<{ transactionId: string }>>;
}

export const defaultMeteringOps: MeteringOps = {
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
}

// bigint paisa from a setting: digit text or a whole number; anything else is "no price" (R16).
function readPrice(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
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

  const settings = await deps.runTx((tx) =>
    ops.repo(tx).readSettings([METERING_SETTING_KEYS.snapshotGbMonthMinor]),
  );
  const price = readPrice(settings.get(METERING_SETTING_KEYS.snapshotGbMonthMinor));

  // 1. snapshot storage: the days that ended, oldest first.
  if (price !== null) {
    const lastEnded = new Date(now.getTime() + DHAKA_OFFSET_MS - DAY_MS);
    for (let back = CATCH_UP_DAYS; back >= 0; back -= 1) {
      const day = new Date(lastEnded.getTime() - back * DAY_MS).toISOString().slice(0, 10);
      let after: string | null = null;
      for (;;) {
        const rows = await deps.runTx((tx) =>
          ops.repo(tx).listUsage(SNAPSHOT_METRIC, day, after, page),
        );
        for (const row of rows) {
          try {
            const outcome = await deps.runTx(async (tx) => {
              const key = ledgerKey.metered(row.resourceId, SNAPSHOT_METRIC, day);
              if (await ops.hasCharge(tx, key)) return "replayed" as const;
              const amountMinor = dailyMeteredChargeMinor(row.quantity, price);
              if (amountMinor === 0n) return "skipped" as const;
              const posted = await ops.post(tx, {
                kind: "metered_charge",
                reference: { type: "resource", id: row.resourceId },
                idempotencyKey: key,
                actor: { type: "system" },
                postings: [
                  {
                    account: { type: "customer_wallet", customerId: row.customerId },
                    direction: "debit",
                    amountMinor,
                  },
                  { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor },
                ],
              });
              if (posted.ok) return "charged" as const;
              if (posted.error !== "insufficient_balance") return "failed" as const;
              // The same grace flow as a renewal (section 11) is a decision for the lifecycle owner (JOURNEY);
              // here the customer gets one notice per resource and day and the next run tries again.
              await ops.repo(tx).insertNotification({
                customerId: row.customerId,
                channel: "email",
                template: UNPAID_TEMPLATE,
                payload: { resourceId: row.resourceId, period: day, metric: SNAPSHOT_METRIC },
                dedupeKey: `lifecycle:${UNPAID_TEMPLATE}:${row.resourceId}:${day}:email`,
              });
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

  return { ...count, priceMissing: price === null };
}
