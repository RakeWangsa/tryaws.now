import type { Locale, Numerals } from "./types";

/** The taka sign. Money is this sign plus a number, never an Intl currency style (16.13). */
export const TAKA = "৳";

const TIME_ZONE = "Asia/Dhaka";
const ZONE_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

function defaultNumerals(locale: Locale): Numerals {
  return locale === "bn" ? "beng" : "latn";
}

function intlTag(locale: Locale, numerals: Numerals | undefined): string {
  return `${locale === "bn" ? "bn-BD" : "en-BD"}-u-nu-${numerals ?? defaultNumerals(locale)}`;
}

/**
 * Formats minor units (paisa) as taka. The number is formatted from a decimal string built from the
 * bigint, so no float is ever formed (R4). `wholeUp` rounds up to whole taka for plan cards.
 */
export function formatMoney(
  minor: bigint,
  o: { locale: Locale; mode?: "exact" | "wholeUp"; numerals?: Numerals },
): string {
  if (typeof minor !== "bigint") {
    throw new TypeError("formatMoney: minor must be a bigint of paisa, never a number");
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const tag = intlTag(o.locale, o.numerals);
  if (o.mode === "wholeUp") {
    if (negative) throw new RangeError("formatMoney: wholeUp is not defined for a negative amount");
    const whole = (abs + 99n) / 100n;
    const text = new Intl.NumberFormat(tag, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(whole.toString() as unknown as number);
    return `${TAKA}${text}`;
  }
  const cents = abs % 100n;
  const decimal = `${abs / 100n}.${cents < 10n ? "0" : ""}${cents}`;
  const text = new Intl.NumberFormat(tag, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(decimal as unknown as number);
  return `${negative ? "-" : ""}${TAKA}${text}`;
}

const PLAIN_DECIMAL_TEXT = /^(\d+)(?:\.(\d+))?$/;

/**
 * Formats plain decimal text (digits and an optional fraction) with the digits of the locale or market,
 * keeping every fraction digit of the text. The text is handed to Intl as text, so no float is formed (R4).
 */
export function formatDecimalText(
  text: string,
  o: { locale: Locale; numerals?: Numerals; minFraction?: number },
): string {
  const match = typeof text === "string" ? PLAIN_DECIMAL_TEXT.exec(text) : null;
  if (match === null) throw new RangeError("formatDecimalText: plain decimal text expected");
  const digits = (match[2] ?? "").length;
  const min = o.minFraction ?? 0;
  return new Intl.NumberFormat(intlTag(o.locale, o.numerals), {
    minimumFractionDigits: min,
    maximumFractionDigits: Math.max(digits, min),
  }).format(text as unknown as number);
}

/** US dollars from the decimal text of the pricing engine (customerUsd): "$5.85". Never an Intl currency style. */
export function formatUsd(text: string, o: { locale: Locale; numerals?: Numerals }): string {
  return `$${formatDecimalText(text, { ...o, minFraction: 2 })}`;
}

/** Parses a Date or an ISO string that carries Z or an offset; anything else is a defect (R16). */
export function toDate(value: Date | string): Date {
  let date: Date;
  if (typeof value === "string") {
    if (!ZONE_SUFFIX.test(value)) {
      throw new RangeError(`formatDate: ${JSON.stringify(value)} has no Z or offset`);
    }
    date = new Date(value);
  } else {
    date = value;
  }
  if (Number.isNaN(date.getTime())) throw new RangeError("formatDate: invalid date");
  return date;
}

/** Formats a moment in Asia/Dhaka time (16.13). */
export function formatDate(
  value: Date | string,
  o: { locale: Locale; variant?: "date" | "datetime" | "time"; numerals?: Numerals },
): string {
  const date = toDate(value);
  const variant = o.variant ?? "date";
  const options: Intl.DateTimeFormatOptions =
    variant === "date"
      ? { dateStyle: "medium" }
      : variant === "time"
        ? { timeStyle: "short" }
        : { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(intlTag(o.locale, o.numerals), {
    ...options,
    timeZone: TIME_ZONE,
  }).format(date);
}
