import { FX_RATE_MAX_AGE_DAYS } from "../pricing/index";

// WPU-Y1. A usage charge (snapshot storage by the day, an unattached static IP by the hour) cannot be priced while the
// USD to BDT rate is older than 7 days. It is NOT dropped: nothing is posted, and once an admin has set a new rate the
// metering passes look back far enough to charge what was held. The ledger key of each charge
// (`meter:<resource>:<metric>:<bucket>`) makes a second pass over the same day or hour a replay, never a second charge (R7).
//
// The look-back of a pass is its normal window, widened by the time the rate was stale before the rate in force took
// effect, for a few days after that. This is pure; the reading of the two rates is the caller's.

const DAY_MS = 86_400_000;

/** After the refreshed rate takes effect the widened look-back is kept this long, so a pass that failed is retried. */
export const MAX_CATCH_UP_AFTER_REFRESH_MS = 3 * DAY_MS;
/** Never look back further than this. */
export const MAX_STALE_WINDOW_MS = 60 * DAY_MS;

const isInstant = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/**
 * Milliseconds from the moment the earlier rate went stale until `now`, while `now` is within three days of the refreshed
 * rate taking effect; otherwise 0. `previousEffectiveFrom` is the start of the rate before the one in force,
 * `currentEffectiveFrom` the start of the one in force.
 */
export function staleWindowMs(
  previousEffectiveFrom: Date | null,
  currentEffectiveFrom: Date,
  now: Date,
): number {
  if (previousEffectiveFrom === null) return 0;
  if (!isInstant(previousEffectiveFrom) || !isInstant(currentEffectiveFrom) || !isInstant(now)) {
    return 0;
  }
  const staleFrom = previousEffectiveFrom.getTime() + FX_RATE_MAX_AGE_DAYS * DAY_MS;
  if (currentEffectiveFrom.getTime() <= staleFrom) return 0;
  const sinceRefresh = now.getTime() - currentEffectiveFrom.getTime();
  if (sinceRefresh < 0 || sinceRefresh > MAX_CATCH_UP_AFTER_REFRESH_MS) return 0;
  return Math.min(now.getTime() - staleFrom, MAX_STALE_WINDOW_MS);
}
