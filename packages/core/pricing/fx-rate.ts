import { PricingInputError } from "./errors";

/** A rate more than this many percent away from the one in force needs a second admin (JOURNEY decision 15, interim default). */
export const FX_SECOND_ADMIN_PERCENT = 5n;

const FX_RATE_TEXT = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;

/**
 * True for text above 0 that fx_rates.rate (numeric(12,6)) keeps exactly: at most 6 digits before and 6 after
 * the point, no sign, no exponent, no padding.
 */
export function isFxRateText(text: unknown): text is string {
  return typeof text === "string" && FX_RATE_TEXT.test(text) && /[1-9]/.test(text);
}

/** The rate in millionths. The text must pass isFxRateText. */
function millionths(rate: string): bigint {
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
}

function refuse(path: "currentFxRate" | "nextFxRate"): never {
  throw new PricingInputError(`${path} is not a rate that can be stored`, [
    {
      path,
      message: "must be plain decimal text above 0, at most 6 digits before and 6 after the point",
    },
  ]);
}

/** True when `next` is more than FX_SECOND_ADMIN_PERCENT percent above or below `current`. Integer arithmetic, no rounding. */
export function fxChangeNeedsSecondAdmin(current: string, next: string): boolean {
  if (!isFxRateText(current)) refuse("currentFxRate");
  if (!isFxRateText(next)) refuse("nextFxRate");
  const from = millionths(current);
  const to = millionths(next);
  const distance = to > from ? to - from : from - to;
  return distance * 100n > from * FX_SECOND_ADMIN_PERCENT;
}

// ---------------------------------------------------------------------------------------------------------
// WPU-Y1. The rate is set by hand in the admin portal (owner decision, JOURNEY 2026-11-13, item 3): there is
// no feed. A rate therefore has a maximum age, so that a forgotten rate cannot price purchases for ever.
// ---------------------------------------------------------------------------------------------------------

/** Owner decision: a rate older than this many days prices nothing (R16). Inclusive: exactly 7 days is still fresh. */
export const FX_RATE_MAX_AGE_DAYS = 7;
/** The alert starts when the rate is older than this many days. */
export const FX_RATE_ALERT_AGE_DAYS = 6;
/** A rate stamped at most this far after the reader's clock is a clock difference between machines, not a future rate. */
export const FX_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
/** A change of more than this many percent needs the extra confirm field (default; configurable by the caller). */
export const FX_CONFIRM_PERCENT = 10n;

const DAY_MS = 86_400_000;

const isInstant = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/**
 * Age in milliseconds, 0 for a small clock difference, or null when it cannot be told (a missing or unreadable
 * time, or a time further in the future than the tolerance).
 */
function ageMs(setAt: unknown, now: unknown): number | null {
  if (!isInstant(setAt) || !isInstant(now)) return null;
  const age = now.getTime() - setAt.getTime();
  if (age >= 0) return age;
  return -age <= FX_CLOCK_SKEW_TOLERANCE_MS ? 0 : null;
}

/**
 * True when the rate set (taking effect) at `setAt` may price something at `now`. Fails closed (R16): a missing
 * rate, a date that is not a date, a rate from the future beyond the clock tolerance and a maximum age that is
 * not a positive finite number are all "not fresh". Pure: the clock is the caller's.
 */
export function rateIsFresh(
  setAt: Date | null | undefined,
  now: Date,
  maxAgeDays: number = FX_RATE_MAX_AGE_DAYS,
): boolean {
  if (typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return false;
  }
  const age = ageMs(setAt, now);
  return age !== null && age <= maxAgeDays * DAY_MS;
}

export type FxRateState = "missing" | "fresh" | "ageing" | "stale";

/** missing: no rate. fresh: up to 6 days. ageing: over 6 and up to 7 days (alert). stale: over 7 days or unreadable (refuses). */
export function fxRateState(setAt: Date | null | undefined, now: Date): FxRateState {
  if (setAt === null || setAt === undefined) return "missing";
  if (!rateIsFresh(setAt, now)) return "stale";
  const age = ageMs(setAt, now);
  return age !== null && age > FX_RATE_ALERT_AGE_DAYS * DAY_MS ? "ageing" : "fresh";
}

/** True when the daily alert applies: the rate is older than 6 days, missing or unreadable. */
export function fxRateAlertDue(setAt: Date | null | undefined, now: Date): boolean {
  return fxRateState(setAt, now) !== "fresh";
}

/** Whole seconds of age for the screen and the log, or null when it cannot be told. */
export function fxRateAgeSeconds(setAt: Date | null | undefined, now: Date): number | null {
  const age = ageMs(setAt, now);
  return age === null ? null : Math.floor(age / 1000);
}

/** True when `next` is MORE than `percent` percent away from `current` (default 10): the extra confirm field is needed. Integer arithmetic. */
export function fxChangeNeedsConfirm(
  current: string,
  next: string,
  percent: bigint = FX_CONFIRM_PERCENT,
): boolean {
  if (typeof percent !== "bigint" || percent <= 0n) {
    throw new PricingInputError("the confirm percent must be a positive whole number", [
      { path: "confirmPercent", message: "must be a positive whole number" },
    ]);
  }
  if (!isFxRateText(current)) refuse("currentFxRate");
  if (!isFxRateText(next)) refuse("nextFxRate");
  const from = millionths(current);
  const to = millionths(next);
  const distance = to > from ? to - from : from - to;
  return distance * 100n > from * percent;
}

/** True when the rate lies between `min` and `max` (both plain rate text, inclusive). Bounds that cannot be read refuse (false). */
export function fxRateInSaneRange(rate: string, bounds: { min: string; max: string }): boolean {
  if (!isFxRateText(rate) || !isFxRateText(bounds.min) || !isFxRateText(bounds.max)) return false;
  const value = millionths(rate);
  return value >= millionths(bounds.min) && value <= millionths(bounds.max);
}
