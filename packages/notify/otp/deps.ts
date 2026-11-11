import type { Clock, Locale } from "@tc/core";
import type { Tx } from "@tc/db";
import type { Numerals } from "../sms/otp-text";
import type { SmsProvider } from "../sms/provider";
import type { SendRule } from "./policy";

// What the service needs from the verified session. A CustomerSession of packages/auth has both.
export interface OtpSession {
  readonly customerId: string;
  readonly locale: Locale;
}

// `run` is withTx in production.
export interface OtpDeps {
  readonly run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly clock: Clock;
  readonly pepper: string;
}

export interface SendOtpDeps extends OtpDeps {
  readonly sms: SmsProvider;
  readonly limits: readonly SendRule[];
  // The market setting `numerals` of 16.13; the default is "beng".
  readonly numerals?: Numerals;
  readonly randomInt?: (maxExclusive: number) => number;
  readonly sendTimeoutMs?: number;
}
