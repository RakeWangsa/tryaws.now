import type { Locale } from "@tc/core";
import type { Numerals } from "../sms/otp-text";

// Text helpers for the messages. No floats (R4): money is bigint paisa, and the grouping is done on
// the digit string. No dependence on the ICU data of the runtime: months are fixed tables, and
// Intl is used for the numeric parts of the Dhaka date only. Fixed TypeError texts, no value in them (R14).

const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"] as const;

export function digits(text: string, locale: Locale, numerals: Numerals): string {
  if (locale !== "bn" || numerals !== "beng") return text;
  return text.replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)] as string);
}

function minorString(minor: bigint | string): string {
  if (typeof minor === "bigint") {
    if (minor < 0n) throw new TypeError("formatMoney: negative amount");
    return minor.toString();
  }
  if (typeof minor !== "string" || !/^[0-9]{1,18}$/.test(minor)) {
    throw new TypeError("formatMoney: the amount is not a whole number of paisa");
  }
  return BigInt(minor).toString();
}

const westernGroups = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function lakhGroups(s: string): string {
  if (s.length <= 3) return s;
  const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${s.slice(-3)}`;
}

// "BDT 1,500.00" in English (ASCII, so an English SMS stays GSM-7); the taka sign and lakh grouping
// in Bengali. Two decimals always (16.13).
export function formatMoney(minor: bigint | string, locale: Locale, numerals: Numerals): string {
  const s = minorString(minor).padStart(3, "0");
  const whole = s.slice(0, -2);
  const frac = s.slice(-2);
  if (locale === "en") return `BDT ${westernGroups(whole)}.${frac}`;
  return `৳${digits(`${lakhGroups(whole)}.${frac}`, "bn", numerals)}`;
}

const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const MONTHS_BN = [
  "জানুয়ারি",
  "ফেব্রুয়ারি",
  "মার্চ",
  "এপ্রিল",
  "মে",
  "জুন",
  "জুলাই",
  "আগস্ট",
  "সেপ্টেম্বর",
  "অক্টোবর",
  "নভেম্বর",
  "ডিসেম্বর",
] as const;

const DHAKA = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Dhaka",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

// The date in Asia/Dhaka time (16.13): stored in UTC, shown in Dhaka.
export function formatDhakaDate(iso: string | Date, locale: Locale, numerals: Numerals): string {
  const at = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(at.getTime())) throw new TypeError("formatDhakaDate: not a date");
  const parts = Object.fromEntries(DHAKA.formatToParts(at).map((p) => [p.type, p.value]));
  const month = Number(parts.month);
  const day = String(Number(parts.day));
  const year = String(Number(parts.year));
  if (locale === "en") return `${day} ${MONTHS_EN[month - 1]} ${year}`;
  return `${digits(day, "bn", numerals)} ${MONTHS_BN[month - 1]} ${digits(year, "bn", numerals)}`;
}

// One pass over the template: a value is never read again, so a customer text that holds `{amount}`
// stays text. A placeholder without a value, or a value without a placeholder, is a bug (R16).
export function fill(template: string, vars: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const out = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_m, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new TypeError("fill: a placeholder has no value");
    used.add(name);
    return vars[name] as string;
  });
  for (const k of Object.keys(vars)) {
    if (!used.has(k)) throw new TypeError("fill: a value has no placeholder");
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
