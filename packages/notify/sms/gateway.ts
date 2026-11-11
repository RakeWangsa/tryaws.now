import type { SmsProvider, SmsSendResult } from "./provider";

// The real SmsProvider (WP2-T3 port) over an injected transport. The gateway is not chosen yet
// (section 17: "SMS provider and sender id"), so the HTTP call is a hand-over: whoever picks the
// gateway writes one SmsTransport. What is the same for every gateway lives here: the E.164 and
// length checks, the time limit and the mapping to the port's two failure reasons. No answer and no
// error carries the number or the text (R14).

export type SmsTransportResult =
  | { readonly status: "accepted"; readonly messageId: string }
  | { readonly status: "refused" }
  | { readonly status: "failed" };

export interface SmsTransport {
  send(request: { readonly to: string; readonly text: string }): Promise<SmsTransportResult>;
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

  async send(to: string, text: string): Promise<SmsSendResult> {
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
    try {
      const r = await Promise.race([this.options.transport.send({ to, text }), timeout]);
      if (r.status === "accepted") return { ok: true, messageId: r.messageId };
      return { ok: false, reason: r.status === "refused" ? "rejected" : "unavailable" };
    } catch {
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
