import type { Logger } from "@tc/core";
import type { PaymentAlert } from "@tc/eps";

/**
 * Finance is told through the log: one structured line per payment that moves to review, and one per verified
 * success that cannot be credited because the wallet is missing (`credit_blocked`, WPU-D3) (open point 4).
 * Amounts are decimal text (bigint.toString), never Number (R4). No name, phone, e-mail or URL (R14).
 * A failing logger must not break the settle path that raised the alert.
 */
export function createLogAlert(log: Logger): PaymentAlert {
  return {
    async raise(event) {
      try {
        log({
          event: event.kind,
          severity: "alert",
          paymentId: event.paymentId,
          reason: event.reason,
          expectedMinor: event.expectedMinor.toString(),
          gotMinor: event.gotMinor === null ? null : event.gotMinor.toString(),
        });
      } catch {
        // swallowed on purpose: the discrepancies row is the durable record
      }
    },
  };
}
