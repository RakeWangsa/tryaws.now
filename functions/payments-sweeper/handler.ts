import type { Logger } from "@tc/core";
import type { SweepCounts } from "@tc/eps";

export const DEFAULT_SWEEP_LIMIT = 25;
export const MAX_SWEEP_LIMIT = 100;

export interface SweeperDeps {
  readonly sweep: (opts: { limit: number }) => Promise<SweepCounts>;
  readonly log: Logger;
  readonly limit?: number;
}

export interface SweeperReport extends SweepCounts {
  readonly limit: number;
  readonly backlog: boolean;
  readonly allUnavailable: boolean;
}

function usableLimit(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SWEEP_LIMIT
    ? value
    : DEFAULT_SWEEP_LIMIT;
}

/**
 * The only thing this job does is call sweep once (R6: the credit path is sweepPayments -> verifyOnce
 * -> settle, nothing here names a payment or an amount). The scheduler's event is never read.
 * Logs counts and booleans only (R14). A throw is logged as a fixed reason and re-thrown with a fixed
 * message, so the invocation fails visibly and nothing about the cause leaks (R3, R16).
 */
export function createSweeperHandler(
  deps: SweeperDeps,
): (event?: unknown) => Promise<SweeperReport> {
  const limit = usableLimit(deps.limit);
  return async (): Promise<SweeperReport> => {
    let counts: SweepCounts;
    try {
      counts = await deps.sweep({ limit });
    } catch {
      deps.log({ event: "payments_sweep_failed", reason: "sweep_threw" });
      throw new Error("payments-sweeper: sweep failed");
    }
    const report: SweeperReport = {
      checked: counts.checked,
      credited: counts.credited,
      expired: counts.expired,
      review: counts.review,
      unavailable: counts.unavailable,
      limit,
      backlog: counts.checked >= limit,
      allUnavailable: counts.checked > 0 && counts.unavailable === counts.checked,
    };
    deps.log({ event: "payments_sweep", ...report });
    return report;
  };
}
