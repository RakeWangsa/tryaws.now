import type { Minor } from "@tc/core";

// EPS amounts are BDT decimal strings. Paisa by integer arithmetic on the digits only (R4): no Number, no float.
// VERIFY (open point 6.5): at most two decimals, no separator.
const EPS_AMOUNT = /^[0-9]{1,15}(\.[0-9]{1,2})?$/;

/** Maximum exclusive: the largest text the parser accepts is 999999999999999.99. */
const LIMIT = 10n ** 17n;

/** The decimal text of EPS as paisa, or null for anything that is not exactly that format. 0 gives 0n (the caller treats it as a mismatch). */
export function parseEpsAmount(text: unknown): Minor | null {
  if (typeof text !== "string" || !EPS_AMOUNT.test(text)) return null;
  const [whole = "", frac = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

/** Paisa as the decimal text of EPS, always two decimals. Refuses a non-positive amount or one the parser would refuse. */
export function formatEpsAmount(minor: Minor): string {
  if (typeof minor !== "bigint" || minor <= 0n || minor >= LIMIT)
    throw new RangeError("eps amount out of range");
  const s = minor.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
