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
 * The refusal for the rate that would price something at `now`, or null when it is fresh. Pure. `effectiveFrom` of
 * the row in force is the moment the rate began to apply: the rate cannot be older than the person who set it
 * wanted it to be, and a scheduled start is at most 90 days ahead (resolveStart).
 */
export function fxFreshnessRefusal(
  fx: { effectiveFrom: Date } | null,
  now: Date,
  maxAgeDays?: number,
): FxRateUnavailable | null {
  if (fx === null) return refusal("missing");
  const fresh =
    maxAgeDays === undefined
      ? rateIsFresh(fx.effectiveFrom, now)
      : rateIsFresh(fx.effectiveFrom, now, maxAgeDays);
  return fresh ? null : refusal("stale");
}

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
