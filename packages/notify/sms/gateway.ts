import {
  isSmsFailureDetail,
  type SmsFailureDetail,
  type SmsProvider,
  type SmsSendResult,
} from "./provider";

// The real SmsProvider (WP2-T3 port) over an injected transport. The HTTP call of a gateway is one
// SmsTransport (WPU-Z3: Gennet, sms/gennet.ts). What is the same for every gateway lives here: the
// E.164 and length checks, the time limit and the mapping to the port's two failure reasons. No answer
// and no error carries the number or the text (R14).
//
// WPU-Z17: a transport may add the reason word of a failure (`detail`); it goes on to the caller only
// when it is one of the port's fixed words. The provider's own refusals and a timeout carry none.

export type SmsTransportResult =
  | { readonly status: "accepted"; readonly messageId: string }
  | { readonly status: "refused"; readonly detail?: SmsFailureDetail }
  | { readonly status: "failed"; readonly detail?: SmsFailureDetail };

export interface SmsTransportRequest {
  readonly to: string;
  readonly text: string;
  // Our id of the message (the OTP challenge id, the notification row id), when the caller has one.
  // A transport derives the gateway's message id from it, so that a repeat of the same message keeps
  // its id. It is an id, never a number or a text.
  readonly reference?: string;
}

export interface SmsTransport {
  send(request: SmsTransportRequest): Promise<SmsTransportResult>;
}

export interface GatewaySmsOptions {
  readonly transport: SmsTransport;
  readonly timeoutMs?: number | undefined;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const MAX_TEXT = 160;
const DEFAULT_TIMEOUT_MS = 10_000;

export class GatewaySmsProvider implements SmsProvider {
  constructor(private readonly options: GatewaySmsOptions) {}

  async send(to: string, text: string, reference?: string): Promise<SmsSendResult> {
    if (!E164.test(to) || text.length === 0 || text.length > MAX_TEXT) {
      return { ok: false, reason: "rejected" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("timeout")),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });
    const request: SmsTransportRequest =
      reference === undefined ? { to, text } : { to, text, reference };
    try {
      const r = await Promise.race([this.options.transport.send(request), timeout]);
      if (r.status === "accepted") return { ok: true, messageId: r.messageId };
      const reason = r.status === "refused" ? "rejected" : "unavailable";
      return isSmsFailureDetail(r.detail)
        ? { ok: false, reason, detail: r.detail }
        : { ok: false, reason };
    } catch {
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
