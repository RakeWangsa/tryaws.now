import type { Minor } from "../types";
import { D, toMinor } from "./decimal";

/**
 * WPU-M3. `amountMinor` × `partDays` / `wholeDays`, rounded half-up to a whole paisa. The division is
 * decimal (the engine's own Big), the result a bigint; no float is ever made (R4). A negative amount,
 * a part above the whole, or days that are not whole numbers (the whole above zero) throw a RangeError
 * and nothing is computed (R16).
 */
export function prorateMinor(amountMinor: Minor, partDays: number, wholeDays: number): Minor {
  if (typeof amountMinor !== "bigint" || amountMinor < 0n) {
    throw new RangeError("prorateMinor: the amount must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(partDays) || !Number.isSafeInteger(wholeDays)) {
    throw new RangeError("prorateMinor: the days must be whole numbers");
  }
  if (wholeDays <= 0 || partDays < 0 || partDays > wholeDays) {
    throw new RangeError("prorateMinor: the part must lie within a whole above zero");
  }
  // The multiplication by the integer amount is exact; the quotient is rounded to the paisa at once.
  return toMinor(new D(amountMinor.toString()).times(partDays).div(wholeDays));
}
