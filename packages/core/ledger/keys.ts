import { isUuid } from "./uuid";

// Spec 9.1: idempotency keys of ledger transactions are derived on the server, from ids.
// Every TypeError text starts with `ledgerKey.<fn>: ` and holds no value (R14).

const DRAFT_HASH = /^[A-Za-z0-9_+/=-]{16,128}$/;
const METRIC = /^[a-z][a-z0-9_]{0,39}$/;
const PERIOD = /^\d{4}-\d{2}-\d{2}(T\d{2})?$/;
/** WPU-Y2: the highest attempt of a renewal key (a retry after a reversed domain renewal). */
export const MAX_RENEWAL_ATTEMPT = 99;

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
  /**
   * The renewal of one period. `attempt` (WPU-Y2) is 0 for the charge of the period; a domain renewal whose charge
   * was reversed because the registry refused it before anything reached it (domain-renewal.ts) may be charged again,
   * under attempt 1, 2, ... (`:a<n>`), so the reversed charge's key does not block a legitimate retry.
   */
  renewal(subscriptionId: string, periodStart: Date, attempt = 0): string {
    const sub = uuidPart("renewal", "subscriptionId", subscriptionId);
    if (!(periodStart instanceof Date) || Number.isNaN(periodStart.getTime())) {
      throw new TypeError("ledgerKey.renewal: periodStart is not a valid Date");
    }
    if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_RENEWAL_ATTEMPT) {
      throw new TypeError("ledgerKey.renewal: attempt is not a whole number from 0 to 99");
    }
    const base = `renew:${sub}:${periodStart.toISOString()}`;
    return attempt === 0 ? base : `${base}:a${attempt}`;
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
