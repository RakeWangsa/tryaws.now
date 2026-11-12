import type { Clock } from "@tc/core";
import type { Tx } from "@tc/db";
import type { EpsGateway } from "./gateway";
import type { StoredPayment } from "./state";

/**
 * What finance is told (open point 10): a payment goes to review (`payment_review`), or a verified success
 * cannot be credited because the customer has no wallet and none can be opened (`credit_blocked`, WPU-D3).
 * Never a name, phone or e-mail (R14).
 */
export interface PaymentAlert {
  raise(event: {
    kind: "payment_review" | "credit_blocked";
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
  /**
   * Runs AFTER the credit transaction has committed (WPU-D3, audit C.8; it ran inside it before). The
   * credit is final by then: a hook that throws is logged and never undoes or hides it. Not retried here.
   * The default does nothing.
   */
  onCredited?: (payment: StoredPayment) => Promise<void>;
}
