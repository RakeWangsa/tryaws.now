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
export type SmsSendResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly reason: "rejected" | "unavailable" };

export interface SmsProvider {
  send(to: string, text: string, reference?: string): Promise<SmsSendResult>;
}
