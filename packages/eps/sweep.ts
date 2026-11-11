import { systemPayments } from "@tc/db";
import type { EpsDeps } from "./deps";
import { safeLog } from "./log";
import { verifyOnce } from "./verify";

export interface SweepCounts {
  checked: number;
  credited: number;
  expired: number;
  review: number;
  unavailable: number;
}

// Open point 9: a payment is asked about two minutes after it was created (the customer may still be
// paying) and expires after 24 hours when EPS did not report a success.
const ASK_AFTER_MS = 2 * 60 * 1000;
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Settles the open payments nobody came back for (9.2.4). Run every 5 minutes by the scheduler
 * (WP5-T4) as worker_rw. One short transaction picks up to `limit` rows, skipping the ones another
 * transaction holds, and ends; each row then takes the same path as a callback (verifyOnce), so a
 * sweeper, a callback and a second sweeper racing on one payment credit once. An unusable limit
 * falls back to the default. Counts only, never an id, in the result and in the log (R14).
 */
export async function sweepPayments(
  deps: EpsDeps,
  opts?: { limit?: number },
): Promise<SweepCounts> {
  const counts: SweepCounts = { checked: 0, credited: 0, expired: 0, review: 0, unavailable: 0 };
  const requested = opts?.limit;
  const limit =
    typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= 1 &&
    requested <= MAX_LIMIT
      ? requested
      : DEFAULT_LIMIT;
  const now = deps.clock.now();
  const expireBefore = new Date(now.getTime() - EXPIRE_AFTER_MS);
  const before = new Date(now.getTime() - ASK_AFTER_MS);

  let rows;
  try {
    rows = await deps.run((tx) => systemPayments.sweepable(tx, { before, limit }));
  } catch {
    // R16: nothing was selected, nothing was changed; the next run tries again.
    safeLog(deps, "eps.sweep", { reason: "select_failed" });
    return counts;
  }

  for (const row of rows) {
    counts.checked += 1;
    const report = await verifyOnce(deps, row.merchantTransactionId, { expireBefore });
    switch (report.kind) {
      case "credited":
        counts.credited += 1;
        break;
      case "expired":
        counts.expired += 1;
        break;
      case "review":
        counts.review += 1;
        break;
      case "unavailable":
      case "error":
        // A row that could not be settled this time is retried at the next run.
        counts.unavailable += 1;
        break;
      default:
        break;
    }
  }
  safeLog(deps, "eps.sweep", { count: counts.checked, ok: true });
  return counts;
}
