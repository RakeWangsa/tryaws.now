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

// Control characters other than tab and newline are refused, not stripped (R16).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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

  const subject = typeof input["subject"] === "string" ? input["subject"].trim() : "";
  if (
    subject.length < 1 ||
    subject.length > SUBJECT_MAX ||
    CONTROL.test(subject) ||
    subject.includes("\n")
  ) {
    fields["subject"] = "invalid";
  }

  const message = typeof input["message"] === "string" ? input["message"].trim() : "";
  if (message.length < 1 || message.length > MESSAGE_MAX || CONTROL.test(message)) {
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
