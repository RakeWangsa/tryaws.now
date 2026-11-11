import type { Clock } from "@tc/core";
import type { Tx } from "@tc/db";
import type { EpsGateway } from "./gateway";
import type { StoredPayment } from "./state";

/** What finance is told when a payment goes to review (open point 10). Never a name, phone or e-mail (R14). */
export interface PaymentAlert {
  raise(event: {
    kind: "payment_review";
    paymentId: string;
    reason: string;
    expectedMinor: bigint;
    gotMinor: bigint | null;
  }): Promise<void>;
}

/** Everything the services need from outside. No process.env, no global clock, no global database (R3, R16). */
export interface EpsDeps {
  gateway: EpsGateway;
  clock: Clock;
  /** One database transaction; production passes withTx. */
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** UUID v7 for the payment primary key. */
  newPaymentId: () => string;
  randomBytes: (n: number) => Uint8Array;
  /** HMAC key for the IP subject of the rate limits; a separate secret, not the OTP key (open point 16). */
  limitKey: string;
  urls: { successUrl: string; failUrl: string; cancelUrl: string };
  alert: PaymentAlert;
  log: (event: string, fields: Record<string, string | number | boolean>) => void;
  /** Runs in the credit transaction (open point 11); the default does nothing. */
  onCredited?: (tx: Tx, payment: StoredPayment) => Promise<void>;
}
