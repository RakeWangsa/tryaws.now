import type { EpsDeps } from "./deps";
import { recheckPayment } from "./recheck";
import type { RecheckOutcome } from "./recheck";
import { handleEpsReturn } from "./returns";
import type { ReturnInput, ReturnResult } from "./returns";
import { sweepPayments } from "./sweep";
import type { SweepCounts } from "./sweep";
import { startTopUp } from "./topup";
import type { TopUpContext, TopUpInput, TopUpResult } from "./topup";
import { verifyPayment } from "./verify";
import type { VerifyOutcome } from "./verify";

/**
 * The shape of contract F, bound to one set of deps. `startTopUp` takes the request context as a third
 * argument (open point 16): the address is not part of F's input, and F's call shape is unchanged.
 * `verifyPayment` is F's `verifyPayment(merchantTransactionId)`; the optional context carries the client
 * address of a browser return so the return limits apply.
 */
export interface Eps {
  startTopUp(
    s: { readonly customerId: string },
    input: TopUpInput,
    ctx: TopUpContext,
  ): Promise<TopUpResult>;
  verifyPayment(merchantTransactionId: string, ctx?: { clientIp?: string }): Promise<VerifyOutcome>;
  handleReturn(input: ReturnInput): Promise<ReturnResult>;
  /** The status page asks whether an open payment of this customer is settled now (WP3-T4). */
  recheckPayment(
    s: { readonly customerId: string },
    paymentId: string,
    ctx: { clientIp: string },
  ): Promise<RecheckOutcome>;
  sweep(opts?: { limit?: number }): Promise<SweepCounts>;
}

export function createEps(deps: EpsDeps): Eps {
  return {
    startTopUp: (s, input, ctx) => startTopUp(deps, s, input, ctx),
    verifyPayment: (merchantTransactionId, ctx) => verifyPayment(deps, merchantTransactionId, ctx),
    handleReturn: (input) => handleEpsReturn(deps, input),
    recheckPayment: (s, paymentId, ctx) => recheckPayment(deps, s, paymentId, ctx),
    sweep: (opts) => sweepPayments(deps, opts),
  };
}
