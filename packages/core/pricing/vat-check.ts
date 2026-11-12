import type { Minor } from "../types";
import { D, parseDecimal, toMinor } from "./decimal";

/**
 * round_half_up(value x rate) in whole minor units (WPU-I5). The invoice (packages/core/invoices) uses it
 * only to CHECK that the VAT it prints is the rate applied to the value it prints; the decimal library
 * stays inside the pricing folder (R4). No amount of a charge is computed from it.
 */
export function roundedShareMinor(value: Minor, rate: string): Minor {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError("roundedShareMinor: the value must be a non-negative bigint");
  }
  return toMinor(new D(value.toString()).times(parseDecimal(rate, "rate")));
}
