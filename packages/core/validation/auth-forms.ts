import { normalizeDisplayName } from "./display-name";
import { normalizeEmail } from "./email";
import { parseOtpCode } from "./otp-code";
import { normalizeBdMobile } from "./phone";
import { checkPassword, PASSWORD_MAX_LENGTH } from "./password";

export type FieldCode =
  | "required"
  | "invalid"
  | "too_short"
  | "too_long"
  | "mismatch"
  | "too_common"
  | "same_as_email"
  | "repeated"
  | "must_accept";

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fields: Record<string, FieldCode> };

/**
 * Individual accounts only: the business option and the company name are deferred (no column,
 * Needs decision), so this input has no accountType and no companyName.
 */
export interface SignUpInput {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  locale: "bn" | "en";
}

type Form = Readonly<Record<string, unknown>>;
type Fields = Record<string, FieldCode>;

const MAX = { email: 320, name: 200, phone: 32, code: 16, password: 512 } as const;

/** A text field: missing or blank is "required", a non-string is "invalid", too long is cut first. */
function text(form: Form, key: string, max: number): { code: FieldCode } | { raw: string } {
  const v = form[key];
  if (v === undefined || v === null) return { code: "required" };
  if (typeof v !== "string") return { code: "invalid" };
  if (v.length > max) return { code: "too_long" };
  if (v.trim() === "") return { code: "required" };
  return { raw: v };
}

function email(form: Form, fields: Fields): string | null {
  const t = text(form, "email", MAX.email);
  if ("code" in t) {
    fields["email"] = t.code;
    return null;
  }
  const n = normalizeEmail(t.raw);
  if (n === null) fields["email"] = "invalid";
  return n;
}

function code(form: Form, fields: Fields): string | null {
  const t = text(form, "code", MAX.code);
  if ("code" in t) {
    fields["code"] = t.code;
    return null;
  }
  const n = parseOtpCode(t.raw);
  if (n === null) fields["code"] = "invalid";
  return n;
}

/** A new password: the full policy. The raw string is returned as typed. */
function newPassword(
  form: Form,
  fields: Fields,
  key: string,
  address: string | null,
): string | null {
  const v = form[key];
  if (v === undefined || v === null || v === "") {
    fields[key] = "required";
    return null;
  }
  if (typeof v !== "string") {
    fields[key] = "invalid";
    return null;
  }
  if (v.length > MAX.password) {
    fields[key] = "too_long";
    return null;
  }
  const r = checkPassword(v, address);
  if (!r.ok) {
    fields[key] = r.issue;
    return null;
  }
  return v;
}

function consent(form: Form, fields: Fields, key: string): void {
  const v = form[key];
  if (v !== "on" && v !== "true") fields[key] = "must_accept";
}

function result<T>(fields: Fields, value: () => T): Parsed<T> {
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value: value() };
}

export function parseSignUpForm(form: Form): Parsed<SignUpInput> {
  const fields: Fields = {};
  let fullName: string | null = null;
  const nameField = text(form, "fullName", MAX.name);
  if ("code" in nameField) fields["fullName"] = nameField.code;
  else {
    fullName = normalizeDisplayName(nameField.raw);
    if (fullName === null) fields["fullName"] = "invalid";
  }
  const addr = email(form, fields);
  let phone: string | null = null;
  const phoneField = text(form, "phone", MAX.phone);
  if ("code" in phoneField) fields["phone"] = phoneField.code;
  else {
    phone = normalizeBdMobile(phoneField.raw);
    if (phone === null) fields["phone"] = "invalid";
  }
  const password = newPassword(form, fields, "password", addr);
  const typed = form["password"];
  if (typeof typed === "string" && typed !== "" && form["passwordConfirm"] !== typed) {
    fields["passwordConfirm"] = "mismatch";
  }
  consent(form, fields, "consentTerms");
  consent(form, fields, "consentAup");
  consent(form, fields, "consentPrivacy");
  const locale = form["locale"] === "en" ? "en" : "bn";
  return result(fields, () => ({
    fullName: fullName as string,
    email: addr as string,
    phone: phone as string,
    password: password as string,
    locale,
  }));
}

/** The password gets no policy here: a check at sign-in would only teach the policy. */
export function parseSignInForm(form: Form): Parsed<{ email: string; password: string }> {
  const fields: Fields = {};
  const addr = email(form, fields);
  const v = form["password"];
  let password: string | null = null;
  if (v === undefined || v === null || v === "") fields["password"] = "required";
  else if (typeof v !== "string") fields["password"] = "invalid";
  else if (v.length > MAX.password || Array.from(v).length > PASSWORD_MAX_LENGTH) {
    fields["password"] = "too_long";
  } else password = v;
  return result(fields, () => ({ email: addr as string, password: password as string }));
}

export function parseEmailForm(form: Form): Parsed<{ email: string }> {
  const fields: Fields = {};
  const addr = email(form, fields);
  return result(fields, () => ({ email: addr as string }));
}

export function parseConfirmEmailForm(form: Form): Parsed<{ email: string; code: string }> {
  const fields: Fields = {};
  const addr = email(form, fields);
  const c = code(form, fields);
  return result(fields, () => ({ email: addr as string, code: c as string }));
}

/** A `passwordConfirm` key, when the form has one, has to match. */
export function parseResetForm(
  form: Form,
): Parsed<{ email: string; code: string; password: string }> {
  const fields: Fields = {};
  const addr = email(form, fields);
  const c = code(form, fields);
  const password = newPassword(form, fields, "password", addr);
  if (
    typeof form["password"] === "string" &&
    form["passwordConfirm"] !== undefined &&
    form["passwordConfirm"] !== form["password"]
  ) {
    fields["passwordConfirm"] = "mismatch";
  }
  return result(fields, () => ({
    email: addr as string,
    code: c as string,
    password: password as string,
  }));
}

export function parsePhoneForm(form: Form): Parsed<{ phone: string }> {
  const fields: Fields = {};
  let phone: string | null = null;
  const t = text(form, "phone", MAX.phone);
  if ("code" in t) fields["phone"] = t.code;
  else {
    phone = normalizeBdMobile(t.raw);
    if (phone === null) fields["phone"] = "invalid";
  }
  return result(fields, () => ({ phone: phone as string }));
}

export function parsePhoneCodeForm(form: Form): Parsed<{ code: string }> {
  const fields: Fields = {};
  const c = code(form, fields);
  return result(fields, () => ({ code: c as string }));
}
