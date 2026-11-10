import Big from "big.js";
import type { Minor } from "../types";

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/** Accepts only plain decimal text (digits, optional fraction). Anything else is a RangeError naming the field. */
export function parseDecimal(text: string, field: string): Big {
  if (typeof text !== "string" || !PLAIN_DECIMAL.test(text)) {
    throw new RangeError(`${field} must be a plain decimal number, got ${JSON.stringify(text)}`);
  }
  return new Big(text);
}

/** Rounds half-up to a whole number of minor units. Does not touch the global Big settings. */
export function toMinor(value: Big): Minor {
  return BigInt(value.round(0, Big.roundHalfUp).toFixed(0));
}
