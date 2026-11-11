import { toAsciiDigits } from "./digits";

/** Exactly six digits (leading zeros kept) after the usual typing noise is removed, else null. */
export function parseOtpCode(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = toAsciiDigits(input).replace(/[\s‎‏-]/g, "");
  return /^[0-9]{6}$/.test(s) ? s : null;
}
