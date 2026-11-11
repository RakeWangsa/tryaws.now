import { toAsciiDigits } from "./digits";

// Whitespace (includes the no-break space), directional marks, brackets, dots, hyphens and dashes.
const IGNORED = /[\s‎‏‪-‮().\-‐-―]/g;
const NATIONAL = /^1[3-9][0-9]{8}$/;
const CANONICAL = /^\+8801[3-9][0-9]{8}$/;

/** The canonical "+880" followed by ten digits, or null. Never throws. */
export function normalizeBdMobile(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = toAsciiDigits(input).replace(IGNORED, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  if (!/^[0-9]*$/.test(s)) return null;
  let national: string;
  if (s.startsWith("880")) {
    national = s.slice(3);
    if (national.startsWith("0")) national = national.slice(1);
  } else if (s.startsWith("0")) {
    national = s.slice(1);
  } else {
    national = s;
  }
  return NATIONAL.test(national) ? `+880${national}` : null;
}

/** Keeps "+880" and the last three digits: "+8801712345678" gives "+880*******678". */
export function maskPhone(e164: string): string {
  if (typeof e164 !== "string" || !CANONICAL.test(e164)) {
    throw new TypeError("maskPhone: not a canonical +880 mobile number");
  }
  return `+880${"*".repeat(7)}${e164.slice(-3)}`;
}
