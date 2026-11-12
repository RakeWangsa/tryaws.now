// The pure part of the signed-in support form (16.10 /support, createSupportRequest). Plain
// validation, no I/O. Text is stored as data and never becomes an AWS name or tag (R11); the form is
// the customer's own, so the customer id is never read from it (R8).

export const SUPPORT_CATEGORIES = [
  "billing",
  "technical",
  "kyc",
  "domain",
  "abuse",
  "other",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export interface SupportRequestInput {
  category: SupportCategory;
  subject: string;
  message: string;
  relatedResourceId: string | null;
  idempotencyKey: string;
}

export type SupportParse =
  { ok: true; value: SupportRequestInput } | { ok: false; fields: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
export const SUBJECT_MAX = 120;
export const MESSAGE_MAX = 5000;

// Refused, never stripped (R16). A single-line field (subject; any name or contact field added later)
// takes no control character (CR, LF, TAB, VT, FF, NEL U+0085 and the rest of Cc), no format character
// (Cf: zero-width, bidi marks) and no line or paragraph separator (U+2028, U+2029), so a subject can
// never split a header, a log line or a notification subject. Text is NFC-normalised before the check.
export const SINGLE_LINE_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// The message keeps only "\n" and tab; CR, NEL, LS, PS and every other control character are refused.
export const MESSAGE_FORBIDDEN = /[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/u;

/** The one rule for a single-line field; returns the NFC text or null (also for empty or too long). */
export function cleanSingleLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFC").trim();
  if (text.length < 1 || text.length > max || SINGLE_LINE_FORBIDDEN.test(text)) return null;
  return text;
}

export function parseSupportRequest(raw: unknown): SupportParse {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fields: Record<string, string> = {};

  const category = input["category"];
  if (
    typeof category !== "string" ||
    !(SUPPORT_CATEGORIES as readonly string[]).includes(category)
  ) {
    fields["category"] = "invalid";
  }

  const cleanSubject = cleanSingleLine(input["subject"], SUBJECT_MAX);
  const subject = cleanSubject ?? "";
  if (cleanSubject === null) fields["subject"] = "invalid";

  const message = typeof input["message"] === "string" ? input["message"].normalize("NFC").trim() : "";
  if (message.length < 1 || message.length > MESSAGE_MAX || MESSAGE_FORBIDDEN.test(message)) {
    fields["message"] = "invalid";
  }

  const related = input["relatedResourceId"];
  let relatedResourceId: string | null = null;
  if (related !== undefined && related !== null && related !== "") {
    if (typeof related === "string" && UUID.test(related)) relatedResourceId = related;
    else fields["relatedResourceId"] = "invalid";
  }

  const key = input["idempotencyKey"];
  if (typeof key !== "string" || !KEY.test(key)) fields["idempotencyKey"] = "invalid";

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      category: category as SupportCategory,
      subject,
      message,
      relatedResourceId,
      idempotencyKey: key as string,
    },
  };
}
