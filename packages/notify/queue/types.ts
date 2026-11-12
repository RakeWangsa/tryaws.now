import type { Locale } from "@tc/core";

// The 23 queued messages of 16.14 (the table has 14 rows; "KYC" has three messages, "Security"
// five, "Low balance, payment expired" two, "Domain" two). Section F leaves TemplateId open.
export const TEMPLATE_IDS = [
  "welcome",
  "kyc_received",
  "kyc_approved",
  "kyc_rejected",
  "topup_receipt",
  "order_paid",
  "order_failed_refunded",
  "wallet_credited_plan_change",
  "resource_ready",
  "renewal_reminder",
  "renewed",
  "grace_started",
  "resource_destroyed",
  "backups_purged",
  "low_balance",
  "payment_expired",
  "security_new_sign_in",
  "security_password_changed",
  "security_totp_changed",
  "security_email_changed",
  "security_phone_changed",
  "domain_contact_pending",
  "domain_renewal_reminder",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

// Messages that are never queued: the phone OTP goes at once through the SmsProvider (WP2-T3) and the
// Cognito emails are sent by Cognito. A queue row would keep a code or a password in
// notifications.payload, which web_rw and worker_rw can read (R14).
export const DIRECT_ONLY_IDS = [
  "phone_otp",
  "cognito_verify_code",
  "cognito_reset_code",
  "cognito_admin_temp_password",
] as const;

export type Channel = "email" | "sms" | "in_app";

export type { Locale };

export type NotifyErrorCode =
  "bad_input" | "unknown_template" | "direct_only" | "bad_data" | "secret_like" | "no_recipient";

// A fixed message per code, and the name of a field at most: never a value (R14).
export class NotifyError extends Error {
  readonly code: NotifyErrorCode;
  readonly field: string | undefined;
  constructor(code: NotifyErrorCode, field?: string) {
    super(field === undefined ? `notify: ${code}` : `notify: ${code} (${field})`);
    this.name = "NotifyError";
    this.code = code;
    this.field = field;
  }
}
