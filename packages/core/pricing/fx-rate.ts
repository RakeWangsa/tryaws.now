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
