import { toAsciiDigits } from "./digits";

export type AmountFieldError = "required" | "format" | "too_low" | "too_high";

export interface TopUpRange {
  readonly minMinor: bigint;
  readonly maxMinor: bigint;
}

const MAX_QUICK = 6;

/**
 * The typed top-up amount is whole taka: ASCII or Bengali digits, with commas, spaces and
 * no-break spaces allowed as grouping. The paisa value is the digits times 100n, by integer
 * arithmetic on a bigint. Anything else (a sign, a decimal point, another script) is a format error.
 */
export function parseTopUpAmount(
  text: unknown,
  range: TopUpRange,
): { ok: true; amountMinor: bigint } | { ok: false; error: AmountFieldError } {
  if (typeof text !== "string") return { ok: false, error: "format" };
  const digits = toAsciiDigits(text.trim()).replace(/[, \xa0]/g, "");
  if (digits === "") return { ok: false, error: "required" };
  if (!/^[0-9]{1,9}$/.test(digits)) return { ok: false, error: "format" };
  const amountMinor = BigInt(digits) * 100n;
  if (amountMinor < range.minMinor) return { ok: false, error: "too_low" };
  if (amountMinor > range.maxMinor) return { ok: false, error: "too_high" };
  return { ok: true, amountMinor };
}

/** Whole-taka quick amounts of the market, as paisa: integers only, inside the range, ascending, no duplicates, at most 6. */
export function quickAmountMinors(quick: readonly unknown[], range: TopUpRange): bigint[] {
  const out: bigint[] = [];
  for (const n of quick) {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) continue;
    const minor = BigInt(n) * 100n;
    if (minor < range.minMinor || minor > range.maxMinor) continue;
    if (!out.includes(minor)) out.push(minor);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out.slice(0, MAX_QUICK);
}
