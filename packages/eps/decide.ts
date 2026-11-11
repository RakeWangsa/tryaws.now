import { isOpen } from "./state";
import type { Action, StoredPayment } from "./state";
import type { VerifyReading } from "./status";

/**
 * What a verified reading means for a stored payment. Pure: writes nothing, reads no clock, throws nothing.
 * Called twice by the services, and only the call on the locked row decides (Review Focus 1).
 * A credit needs a success, the same id, the same amount, an open payment and market currency (R6, R16).
 */
export function decide(input: {
  payment: StoredPayment;
  reading: VerifyReading;
  gatewayIdUsedElsewhere: boolean;
}): Action {
  const { payment, reading, gatewayIdUsedElsewhere } = input;
  if (payment.status === "credited") return { type: "noop", reason: "already_credited" };
  if (payment.status === "review") return { type: "noop", reason: "in_review" };
  if (payment.currency !== "BDT") return { type: "review", reason: "currency" };

  if (reading.merchantTransactionId !== payment.merchantTransactionId) {
    return reading.status === "success"
      ? { type: "review", reason: "id_mismatch" }
      : {
          type: "noop",
          reason:
            reading.status === "pending" && reading.merchantTransactionId === null
              ? "pending"
              : "unknown",
        };
  }

  const open = isOpen(payment.status);
  switch (reading.status) {
    case "success":
      if (reading.totalAmountMinor === null || reading.totalAmountMinor !== payment.amountMinor) {
        return { type: "review", reason: "amount_mismatch" };
      }
      // A success that also carries an error code is not a clean success: finance looks at it (R16).
      // (VERIFY: whether EPS sends an empty value or a zero code on success; zeros count as none.)
      if (reading.errorCode !== null && !/^0+$/.test(reading.errorCode))
        return { type: "review", reason: "error_code" };
      if (!open) return { type: "review", reason: "late_success" };
      if (gatewayIdUsedElsewhere) return { type: "review", reason: "gateway_id_reused" };
      return { type: "credit", gatewayTransactionId: reading.epsTransactionId };
    case "failed":
    case "cancelled":
      return open ? { type: "move", to: reading.status } : { type: "noop", reason: "closed" };
    case "pending":
      return { type: "noop", reason: "pending" };
    default:
      return { type: "noop", reason: "unknown" };
  }
}
