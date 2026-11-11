import { isUuid } from "./uuid";

// Spec 9.1: idempotency keys of ledger transactions are derived on the server, from ids.
// Every TypeError text starts with `ledgerKey.<fn>: ` and holds no value (R14).

const DRAFT_HASH = /^[A-Za-z0-9_+/=-]{16,128}$/;
const METRIC = /^[a-z][a-z0-9_]{0,39}$/;
const PERIOD = /^\d{4}-\d{2}-\d{2}(T\d{2})?$/;

function uuidPart(fn: string, part: string, value: unknown): string {
  if (!isUuid(value)) throw new TypeError(`ledgerKey.${fn}: ${part} is not a UUID`);
  return value.toLowerCase();
}

export const ledgerKey = Object.freeze({
  topup(paymentId: string): string {
    return `topup:${uuidPart("topup", "paymentId", paymentId)}`;
  },
  purchase(draftTokenHash: string): string {
    if (typeof draftTokenHash !== "string" || !DRAFT_HASH.test(draftTokenHash)) {
      throw new TypeError("ledgerKey.purchase: draftTokenHash has the wrong form");
    }
    return `order:${draftTokenHash}`;
  },
  reversal(transactionId: string): string {
    return `reversal:${uuidPart("reversal", "transactionId", transactionId)}`;
  },
  orderReversal(orderId: string): string {
    return `order-reversal:${uuidPart("orderReversal", "orderId", orderId)}`;
  },
  renewal(subscriptionId: string, periodStart: Date): string {
    const sub = uuidPart("renewal", "subscriptionId", subscriptionId);
    if (!(periodStart instanceof Date) || Number.isNaN(periodStart.getTime())) {
      throw new TypeError("ledgerKey.renewal: periodStart is not a valid Date");
    }
    return `renew:${sub}:${periodStart.toISOString()}`;
  },
  metered(resourceId: string, metric: string, period: string): string {
    const res = uuidPart("metered", "resourceId", resourceId);
    if (typeof metric !== "string" || !METRIC.test(metric)) {
      throw new TypeError("ledgerKey.metered: metric has the wrong form");
    }
    if (typeof period !== "string" || !PERIOD.test(period)) {
      throw new TypeError("ledgerKey.metered: period has the wrong form");
    }
    return `meter:${res}:${metric}:${period}`;
  },
  adjustment(requestId: string): string {
    return `adjustment:${uuidPart("adjustment", "requestId", requestId)}`;
  },
  refund(requestId: string): string {
    return `refund:${uuidPart("refund", "requestId", requestId)}`;
  },
});
