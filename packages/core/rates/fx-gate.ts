import { rateIsFresh } from "../pricing/index";
import type { Result } from "../types";

/**
 * WPU-Y1. The stable machine code of a refusal because the USD to BDT rate is missing or older than its maximum
 * age (7 days). ErrorCode is a contract (docs/spec/F), so no new error code is added: the refusal is
 * `upstream_unavailable` with `data.code = "prices_updating"` and `fields.fxRate = "missing" | "stale"`.
 * The customer text (bn and en) says only that prices are being updated and to try later; it names no rate,
 * no age and no admin step.
 */
export const FX_RATE_UNAVAILABLE_CODE = "prices_updating";

export interface FxRateUnavailable {
  ok: false;
  error: "upstream_unavailable";
  fields: { fxRate: "missing" | "stale" };
  data: { code: typeof FX_RATE_UNAVAILABLE_CODE };
}

/**
 * The refusal for the rate that would price something at `now`, or null when it is fresh. Pure.
 * WPU-Y9 (R16): the age is the time since the rate was ENTERED (`createdAt`, the approval), not since the start it
 * names. A rate typed once and scheduled ahead therefore cannot price for longer than the maximum age counted from
 * its entry. A rate whose start is still ahead of `now` (beyond the clock tolerance) is not in force: refused. A
 * missing or unreadable `createdAt` refuses.
 */
export function fxFreshnessRefusal(
  fx: { effectiveFrom: Date; createdAt: Date } | null,
  now: Date,
  maxAgeDays?: number,
): FxRateUnavailable | null {
  if (fx === null) return refusal("missing");
  // The start is checked with the same rule as before: a start from the future beyond the tolerance is not fresh.
  const started = rateIsFresh(fx.effectiveFrom, now, FUTURE_CHECK_DAYS);
  const entered =
    maxAgeDays === undefined
      ? rateIsFresh(fx.createdAt, now)
      : rateIsFresh(fx.createdAt, now, maxAgeDays);
  return started && entered ? null : refusal("stale");
}

// Only used to ask "has the start been reached": a start older than this is not a freshness problem of the start.
const FUTURE_CHECK_DAYS = 36_500;

function refusal(why: "missing" | "stale"): FxRateUnavailable {
  return {
    ok: false,
    error: "upstream_unavailable",
    fields: { fxRate: why },
    data: { code: FX_RATE_UNAVAILABLE_CODE },
  };
}

/** True for exactly the refusal above: what a renewal or a metered charge keeps pending instead of dropping. */
export function isFxRateUnavailable(result: Result<unknown> | null | undefined): boolean {
  if (result === null || result === undefined || result.ok) return false;
  const data = result.data as { code?: unknown } | undefined;
  return result.error === "upstream_unavailable" && data?.code === FX_RATE_UNAVAILABLE_CODE;
}
