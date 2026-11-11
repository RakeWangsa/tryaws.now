import type { CookieSpec } from "@tc/auth";
import type { FieldCode } from "@tc/core";
import type { PendingCookieSpec } from "./pending.ts";

// What a form shows after an action. Serialisable and never holding a secret: no password, no code,
// no token, no Cognito session (R14). The Server Action wrapper returns it to useActionState.

export type AuthErrorCode =
  | "invalid"
  | "rate_limited"
  | "unavailable"
  | "not_open"
  | "bad_origin"
  | "code_wrong"
  | "sign_in_failed"
  | "suspended"
  | "password_rejected"
  | "totp_unsupported";

export const AUTH_ERROR_CODES: readonly AuthErrorCode[] = [
  "invalid",
  "rate_limited",
  "unavailable",
  "not_open",
  "bad_origin",
  "code_wrong",
  "sign_in_failed",
  "suspended",
  "password_rejected",
  "totp_unsupported",
];

export const FIELD_CODES: readonly FieldCode[] = [
  "required",
  "invalid",
  "too_short",
  "too_long",
  "mismatch",
  "too_common",
  "same_as_email",
  "repeated",
  "must_accept",
];

export type FormState =
  | { status: "idle" }
  | {
      status: "error";
      code: AuthErrorCode;
      fields?: Record<string, FieldCode>;
      values?: Record<string, string>;
      retryAfterSeconds?: number;
      ref: string;
    }
  // A relative path, already localised and checked against the allow-list (U12).
  | { status: "done"; redirectTo: string };

/** The only form fields an error state may give back to the browser. Never a password or a code. */
export const ECHOED_FIELDS: readonly string[] = ["fullName", "email", "phone", "locale", "next"];

/** What a core may ask the Server Action wrapper to do. The wrapper owns cookies() and redirect(). */
export interface Effects {
  setCookies: CookieSpec[];
  clearCookies: CookieSpec[];
  /** A value for the pending cookie, "clear" to remove it, null to leave it alone. */
  pending: string | null | "clear";
}

export type Outcome = { state: FormState; effects: Effects };

export type { PendingCookieSpec };
