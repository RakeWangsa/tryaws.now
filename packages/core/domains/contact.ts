import type { Result } from "../types";
import { normalizeEmail } from "../validation/email";

// WP7-T4, spec 12: the registrant contact (the customer is the registrant) in the fields of Route 53
// Domains `ContactDetail`. Pure. It is personal data (R14): a refusal names a field and a constant code and
// never a value, and `redactContact` is the only view that may reach a log or a notification.

export const CONTACT_TYPES = ["PERSON", "COMPANY"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export interface RegistrantContact {
  readonly contactType: ContactType;
  readonly firstName: string;
  readonly lastName: string;
  readonly organizationName?: string;
  readonly email: string;
  /** Route 53 form: `+880.1712345678`. */
  readonly phoneNumber: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly countryCode: string;
  readonly zipCode: string;
}

const MAX_TEXT = 255;
const PHONE = /^\+\d{1,3}\.\d{4,15}$/;
const COUNTRY = /^[A-Z]{2}$/;
// Plain text only: no control characters, no markup (the value reaches a registry and a WHOIS record).
const CONTROL = /[<>]/;
const hasControl = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length >= 1 &&
    trimmed.length <= max &&
    !CONTROL.test(trimmed) &&
    !hasControl(trimmed)
    ? trimmed
    : null;
}

export function parseRegistrantContact(raw: unknown): Result<RegistrantContact> {
  if (!isRecord(raw)) return { ok: false, error: "validation", fields: { contact: "invalid" } };
  const fields: Record<string, string> = {};
  const need = (key: string): string => {
    const value = text(raw[key]);
    if (value === null) fields[key] = "invalid";
    return value ?? "";
  };

  const typeRaw = raw["contactType"];
  const typeOk = typeRaw === "PERSON" || typeRaw === "COMPANY";
  if (!typeOk) fields["contactType"] = "invalid";
  const contactType: ContactType = typeRaw === "COMPANY" ? "COMPANY" : "PERSON";
  const firstName = need("firstName");
  const lastName = need("lastName");
  const addressLine1 = need("addressLine1");
  const city = need("city");
  const state = need("state");
  const zipCode = need("zipCode");

  let organizationName: string | undefined;
  if (contactType === "COMPANY") {
    const org = text(raw["organizationName"]);
    if (org === null) fields["organizationName"] = "required";
    else organizationName = org;
  }
  let addressLine2: string | undefined;
  if (raw["addressLine2"] !== undefined && raw["addressLine2"] !== "") {
    const second = text(raw["addressLine2"]);
    if (second === null) fields["addressLine2"] = "invalid";
    else addressLine2 = second;
  }

  const email = normalizeEmail(raw["email"]);
  if (email === null) fields["email"] = "invalid";
  const phoneRaw = raw["phoneNumber"];
  const phoneNumber = typeof phoneRaw === "string" ? phoneRaw.trim() : "";
  if (!PHONE.test(phoneNumber)) fields["phoneNumber"] = "invalid";
  const countryRaw = raw["countryCode"];
  const countryCode = typeof countryRaw === "string" ? countryRaw.trim() : "";
  if (!COUNTRY.test(countryCode)) fields["countryCode"] = "invalid";

  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      contactType,
      firstName,
      lastName,
      ...(organizationName === undefined ? {} : { organizationName }),
      email: email as string,
      phoneNumber,
      addressLine1,
      ...(addressLine2 === undefined ? {} : { addressLine2 }),
      city,
      state,
      countryCode,
      zipCode,
    },
  };
}

/** What may be logged or put in a message: the type, the country and the domain part of the e-mail. */
export function redactContact(contact: RegistrantContact): {
  readonly contactType: ContactType;
  readonly countryCode: string;
  readonly emailDomain: string;
} {
  return {
    contactType: contact.contactType,
    countryCode: contact.countryCode,
    emailDomain: contact.email.slice(contact.email.lastIndexOf("@") + 1),
  };
}
