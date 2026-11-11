import type { SmsProvider, SmsSendResult } from "./provider";

export interface SentSms {
  readonly to: string;
  readonly text: string;
  readonly messageId: string;
}

export type FailureMode = "rejected" | "unavailable" | "throw" | "hang";

const E164 = /^\+[1-9][0-9]{7,14}$/;
const MAX_TEXT = 160;

// For tests and local runs only. It keeps every text, plain codes included, in memory and sends
// nothing, so it must never run where real customers sign up. It refuses to be built unless
// NODE_ENV is "test" or "development": a deny-list for "production" alone would fail open where a
// function leaves NODE_ENV unset, and R16 says to refuse when unsure.
export class InMemorySmsProvider implements SmsProvider {
  readonly sent: SentSms[] = [];
  private failures: FailureMode[] = [];
  private counter = 0;

  constructor() {
    const env = process.env.NODE_ENV;
    if (env !== "test" && env !== "development") {
      throw new Error("InMemorySmsProvider is for tests and local runs only");
    }
  }

  failNext(mode: FailureMode, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(mode);
  }

  // Clears the recorded messages, the queued failures and the numbering, so that an unfinished
  // failNext("hang") of a failed test cannot leak into the next one.
  reset(): void {
    this.sent.length = 0;
    this.failures = [];
    this.counter = 0;
  }

  send(to: string, text: string): Promise<SmsSendResult> {
    // A gateway refuses these before it looks at anything else.
    if (!E164.test(to) || text.length === 0 || text.length > MAX_TEXT) {
      return Promise.resolve({ ok: false, reason: "rejected" });
    }
    const mode = this.failures.shift();
    if (mode === "rejected" || mode === "unavailable") {
      return Promise.resolve({ ok: false, reason: mode });
    }
    // On purpose it echoes the number and the text: it is what a careless gateway client does, and
    // the service must not pass it on.
    if (mode === "throw") return Promise.reject(new Error(`gateway failed for ${to}: ${text}`));
    if (mode === "hang") return new Promise<SmsSendResult>(() => {});
    this.counter += 1;
    const messageId = `fake-${this.counter}`;
    this.sent.push({ to, text, messageId });
    return Promise.resolve({ ok: true, messageId });
  }
}
