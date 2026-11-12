import { toAsciiDigits } from "./digits";

// The billing profile of a customer (WPU-I3): the name, the address and the tax identifier that the
// Mushak 6.3 invoice prints for the buyer. Pure. A BIN (13 digits, a registered business) is a business
// identifier: it is checked here and stored through the customer's own repository, and is never logged
// (R14). Every field is optional; an empty field is null. There is no NID (WPU-D3, owner decision:
// the service is prepaid, an individual needs no national id, only a business may give a BIN).

export const BILLING_NAME_MIN = 2;
export const BILLING_NAME_MAX = 120;
export const BILLING_ADDRESS_MIN = 5;
export const BILLING_ADDRESS_MAX = 300;
/** Longer raw input is refused before any work is done on it. */
const RAW_MAX = 2000;

export type BillingFieldCode = "invalid" | "too_short" | "too_long";

export interface BillingProfileInput {
  billingName: string | null;
  billingAddress: string | null;
  customerBin: string | null;
}

export type BillingParsed =
  | { readonly ok: true; readonly value: BillingProfileInput }
  | { readonly ok: false; readonly fields: Record<string, BillingFieldCode> };

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
// ZWNJ and ZWJ belong to correct Bengali spelling; allowed between two non-space characters only.
const JOINERS = /[‌‍]/gu;
const BAD_JOINER = /(^|\s)[‌‍]|[‌‍](\s|$)|[‌‍]{2}/u;
const MARKUP = /[<>]/;

type Free = { ok: true; value: string | null } | { ok: false; code: BillingFieldCode };

/** Free text: empty is null; NFC, whitespace runs (a newline too) become one space. */
function freeText(raw: unknown, min: number, max: number): Free {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, code: "invalid" };
  if (raw.length > RAW_MAX) return { ok: false, code: "too_long" };
  const nfc = raw.normalize("NFC");
  if (nfc.trim() === "") return { ok: true, value: null };
  if (BAD_JOINER.test(nfc)) return { ok: false, code: "invalid" };
  // Whitespace (tab, newline, no-break space) is folded first; any control or format character left
  // (NUL, bell, zero-width space, bidi override) refuses the text.
  const s = nfc.replace(/\s+/gu, " ").trim();
  if (CONTROL_OR_FORMAT.test(s.replace(JOINERS, "")) || MARKUP.test(s)) {
    return { ok: false, code: "invalid" };
  }
  const length = Array.from(s).length;
  if (length < min) return { ok: false, code: "too_short" };
  if (length > max) return { ok: false, code: "too_long" };
  return { ok: true, value: s };
}

/** Digits only, in Latin or Bengali; spaces and hyphens are separators and are dropped. */
function digitsOf(raw: unknown): Free {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > 64) return { ok: false, code: "invalid" };
  const s = toAsciiDigits(raw.normalize("NFC")).replace(/[\s-]/gu, "");
  if (s === "") return { ok: true, value: null };
  return /^[0-9]+$/.test(s) ? { ok: true, value: s } : { ok: false, code: "invalid" };
}

export function parseBillingProfile(form: unknown): BillingParsed {
  const input =
    typeof form === "object" && form !== null && !Array.isArray(form)
      ? (form as Record<string, unknown>)
      : {};
  const fields: Record<string, BillingFieldCode> = {};
  const out: BillingProfileInput = {
    billingName: null,
    billingAddress: null,
    customerBin: null,
  };

  const name = freeText(input["billingName"], BILLING_NAME_MIN, BILLING_NAME_MAX);
  if (name.ok) out.billingName = name.value;
  else fields["billingName"] = name.code;

  const address = freeText(input["billingAddress"], BILLING_ADDRESS_MIN, BILLING_ADDRESS_MAX);
  if (address.ok) out.billingAddress = address.value;
  else fields["billingAddress"] = address.code;

  const bin = digitsOf(input["customerBin"]);
  if (!bin.ok) fields["customerBin"] = bin.code;
  else if (bin.value !== null && bin.value.length !== 13) fields["customerBin"] = "invalid";
  else out.customerBin = bin.value;

  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value: out };
}
