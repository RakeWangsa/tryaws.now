import type { Locale } from "@tc/core";

// The market setting `numerals` of 16.13: Bengali or Latin digits for counts.
export type Numerals = "beng" | "latn";

const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"] as const;

const toBengali = (n: number): string =>
  String(n).replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)] as string);

// One message: no link (an unregistered A2P SMS with a link is filtered by operators) and no AWS
// name (16.13). The code is always in Latin digits: it is a technical value (16.13), and Latin
// digits keep the one-time-code autofill of phones working. Fixed TypeError texts: they never hold
// the code (R14).
export function otpSmsText(
  locale: Locale,
  numerals: Numerals,
  code: string,
  minutes: number,
): string {
  if (locale !== "bn" && locale !== "en") throw new TypeError("otpSmsText: unknown locale");
  if (numerals !== "beng" && numerals !== "latn")
    throw new TypeError("otpSmsText: unknown numerals");
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    throw new TypeError("otpSmsText: the code is not six digits");
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new TypeError("otpSmsText: minutes must be an integer from 1 to 60");
  }
  if (locale === "en") {
    return `MeghVPS verification code: ${code}. Valid for ${minutes} minutes. Do not share it.`;
  }
  const shown = numerals === "beng" ? toBengali(minutes) : String(minutes);
  return `MeghVPS যাচাই কোড: ${code}। মেয়াদ ${shown} মিনিট। কাউকে জানাবেন না।`;
}
