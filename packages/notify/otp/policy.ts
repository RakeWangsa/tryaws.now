// The numbers of 6.1: "6 digits, stored hashed, 5 minute expiry, 5 attempts, 3 sends per hour per
// number and per IP". Frozen, so that no caller can change them at run time.
export const OTP = Object.freeze({
  codeDigits: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  // How far the clock of the verifier may be behind the clock that issued the code.
  clockBehindSeconds: 60,
  // The resend timer of 16.9.
  resendSeconds: 60,
  sendTimeoutMs: 5000,
} as const);

export interface SendRule {
  readonly kind: "customer" | "ip" | "phone";
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

// The first two rules are 6.1. The third is the resend timer of 16.9 as "one a clock minute per
// number" (open point 7). Decision 31 of the owner changes only this list.
export const OTP_SEND_RULES: readonly SendRule[] = Object.freeze([
  Object.freeze({ kind: "phone", action: "otp.send", limit: 3, windowSeconds: 3600 }),
  Object.freeze({ kind: "ip", action: "otp.send", limit: 3, windowSeconds: 3600 }),
  Object.freeze({
    kind: "phone",
    action: "otp.resend",
    limit: 1,
    windowSeconds: OTP.resendSeconds,
  }),
] satisfies SendRule[]);

// Item 29 (WPU-B6): the daily cap of OTP SMS for one customer, whatever the number or the network. The
// number is a policy of the owner (decision 31). Until it is decided the default is conservative (10
// sends in 24 hours; the hourly rules above already stop a burst) and the market setting
// `otp.sms_daily_cap` (a whole number, scope market) can change it without a deploy.
export const OTP_DAILY_CAP_SETTING = "otp.sms_daily_cap";
export const OTP_DAILY_CAP_DEFAULT = 10;
export const OTP_DAILY_WINDOW_SECONDS = 86_400;

/** The send rules with the daily cap of the customer. A bad cap falls back to the default (R16). */
export function otpSendRules(dailyCap: number | null | undefined): readonly SendRule[] {
  const cap =
    typeof dailyCap === "number" && Number.isInteger(dailyCap) && dailyCap >= 1
      ? Math.min(dailyCap, OTP_DAILY_CAP_DEFAULT * 10)
      : OTP_DAILY_CAP_DEFAULT;
  return Object.freeze([
    ...OTP_SEND_RULES,
    Object.freeze({
      kind: "customer",
      action: "otp.daily",
      limit: cap,
      windowSeconds: OTP_DAILY_WINDOW_SECONDS,
    } satisfies SendRule),
  ]);
}

// The idempotency key a caller (the Server Action) sends with a send (R7).
export const OTP_IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
