// The port to an SMS gateway. `to` is a canonical E.164 number; an adapter never normalises it.
//
// The contract of a real adapter (WP5-T5): `rejected` means the gateway refused the number or the
// text and nothing was sent; `unavailable` means anything else (network error, timeout, 5xx, quota,
// sender not allowed). It maps every gateway answer to this union, and no error it raises may carry
// the number or the text (R14).
//
// `reference` (WPU-Z3): our id of the message, when the caller has one: the OTP challenge id or the
// notification row id. An adapter derives the gateway's own message id from it, so that a repeat of
// the same message keeps its id. It is an id, never a number or a text.
//
// `detail` (WPU-Z17, optional): why a send failed, as one of the fixed words below, for the caller's log.
// `invalid_number` goes with `rejected`, the others with `unavailable`. It is never the gateway's own
// text, the number, the text or a secret (R3, R14).
export const SMS_FAILURE_DETAILS = [
  "token",
  "sender",
  "ip_not_whitelisted",
  "duplicate",
  "rate_limited",
  "invalid_number",
  "unknown",
] as const;

export type SmsFailureDetail = (typeof SMS_FAILURE_DETAILS)[number];

// True only for one of the fixed words. A caller logs `detail` only after this check: an adapter is
// an interface, and anything else in that field might hold the number or the text.
export function isSmsFailureDetail(value: unknown): value is SmsFailureDetail {
  return typeof value === "string" && (SMS_FAILURE_DETAILS as readonly string[]).includes(value);
}

export type SmsSendResult =
  | { readonly ok: true; readonly messageId: string }
  | {
      readonly ok: false;
      readonly reason: "rejected" | "unavailable";
      readonly detail?: SmsFailureDetail;
    };

export interface SmsProvider {
  send(to: string, text: string, reference?: string): Promise<SmsSendResult>;
}
