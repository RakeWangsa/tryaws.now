// The port to an SMS gateway. `to` is a canonical E.164 number; an adapter never normalises it.
//
// The contract of a real adapter (WP5-T5): `rejected` means the gateway refused the number or the
// text and nothing was sent; `unavailable` means anything else (network error, timeout, 5xx, quota,
// sender not allowed). It maps every gateway answer to this union, and no error it raises may carry
// the number or the text (R14).
export type SmsSendResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly reason: "rejected" | "unavailable" };

export interface SmsProvider {
  send(to: string, text: string): Promise<SmsSendResult>;
}
