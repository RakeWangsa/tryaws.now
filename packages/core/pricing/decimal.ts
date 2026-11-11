import Big from "big.js";
import type { Minor } from "../types";
import { PricingInputError } from "./errors";

/**
 * The engine's own Big constructor. Settings such as Big.RM, Big.DP or Big.strict that other code
 * sets on the global constructor do not reach it, so they cannot change a price.
 */
export const D = Big();

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/** True only for plain decimal text: digits with an optional fraction. */
export function isPlainDecimal(text: unknown): text is string {
  return typeof text === "string" && PLAIN_DECIMAL.test(text);
}

/** True only for plain decimal text with at least one digit from 1 to 9, so above zero. */
export function isPositiveDecimal(text: unknown): text is string {
  return isPlainDecimal(text) && /[1-9]/.test(text);
}

/**
 * True when a is at most b, both plain non-negative decimal text. The one place outside the engine's
 * arithmetic where callers compare decimals, so that no other package imports big.js (R4).
 */
export function decimalAtMost(a: string, b: string): boolean {
  if (!isPlainDecimal(a) || !isPlainDecimal(b)) {
    throw new RangeError("decimalAtMost: both values must be plain decimal text");
  }
  return new D(a).lte(new D(b));
}

/** How a refused value is shown in a message: short, and never by calling the value itself. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).slice(0, 40);
  return `a value of type ${value === null ? "null" : typeof value}`;
}

/**
 * Accepts only plain decimal text (digits, optional fraction). Anything else is a PricingInputError
 * with one problem at the field.
 */
export function parseDecimal(text: unknown, field: string): Big {
  if (!isPlainDecimal(text)) {
    const message = `${field} must be a plain decimal number, got ${describe(text)}`;
    throw new PricingInputError(message, [{ path: field, message }]);
  }
  return new D(text);
}

/** Rounds half-up to a whole number of minor units. Passes the rounding mode explicitly. */
export function toMinor(value: Big): Minor {
  return BigInt(value.round(0, D.roundHalfUp).toFixed(0));
}
