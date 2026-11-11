import type { Result } from "@tc/core";
import { customerRepos } from "@tc/db";
import type { PaymentRow } from "@tc/db";
import type { EpsDeps } from "./deps";
import { ipSubject, RECHECK_LIMITS } from "./limits";
import { safeLog } from "./log";
import { isOpen, PAYMENT_STATES, publicState } from "./state";
import type { PaymentState, PublicState } from "./state";
import { verifyPayment } from "./verify";

export type RecheckOutcome = Result<{ state: PublicState; review: boolean }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID.test(value);

type Stage =
  { kind: "done"; result: RecheckOutcome } | { kind: "open"; merchantTransactionId: string };

const asState = (row: PaymentRow): PaymentState => {
  if (!(PAYMENT_STATES as readonly string[]).includes(row.status)) {
    throw new TypeError("payment: unknown status");
  }
  return row.status as PaymentState;
};

const answer = (state: PaymentState): RecheckOutcome => ({
  ok: true,
  value: { state: publicState(state), review: state === "review" },
});

/**
 * The status page asks: is this payment settled now? In the order of R9: the customer is the one of
 * the session; the payment id is a UUID; the row is read through the customer's own repository (a
 * row of someone else is "not found" and EPS is never asked, R8); a row that is not open answers
 * from itself; a per-customer limit; then the one server-to-server verify of `verifyPayment`, which
 * is the only place that credits (R6) and applies the per-payment and per-address limits; the audit
 * row. Whatever threw, nothing is promised (R16), and no error text is passed on (R14).
 */
export async function recheckPayment(
  deps: EpsDeps,
  s: { readonly customerId: string },
  paymentId: string,
  ctx: { clientIp: string },
): Promise<RecheckOutcome> {
  try {
    return await recheck(deps, s, paymentId, ctx);
  } catch {
    safeLog(deps, "eps.recheck", { reason: "exception" });
    return { ok: false, error: "internal" };
  }
}

async function recheck(
  deps: EpsDeps,
  s: { readonly customerId: string },
  paymentId: string,
  ctx: { clientIp: string },
): Promise<RecheckOutcome> {
  // 1. authenticate: only the customer id of the session is used.
  const customerId = s?.customerId;
  if (typeof customerId !== "string" || !isUuid(customerId)) {
    return { ok: false, error: "unauthenticated" };
  }

  // 2. validate. A payment id that is not a UUID is "no such payment" (no query, no EPS call). An
  // address that cannot be read is refused: the per-address rule of verifyPayment needs one (R16).
  if (typeof paymentId !== "string" || !isUuid(paymentId)) return { ok: false, error: "not_found" };
  const clientIp = ctx?.clientIp;
  if (ipSubject(deps.limitKey, clientIp) === null || typeof clientIp !== "string") {
    return { ok: false, error: "validation", fields: { clientIp: "invalid" } };
  }

  // 3 to 5. One transaction: read the row of this customer, answer from it when it is not open,
  // else count the customer's limit.
  const now = deps.clock.now();
  const stage = await deps.run<Stage>(async (tx): Promise<Stage> => {
    const repos = customerRepos(tx, customerId);
    const row = await repos.payments.get(paymentId);
    if (row === null) return { kind: "done", result: { ok: false, error: "not_found" } };
    const state = asState(row);
    if (!isOpen(state)) return { kind: "done", result: answer(state) };
    const decision = await repos.rateLimits.consume([RECHECK_LIMITS.customer], now);
    if (!decision.allowed) {
      return {
        kind: "done",
        result: {
          ok: false,
          error: "rate_limited",
          data: { retryAfterSeconds: decision.retryAfterSeconds },
        },
      };
    }
    return { kind: "open", merchantTransactionId: row.merchantTransactionId };
  });
  if (stage.kind === "done") return stage.result;

  // 6. The one place that asks EPS and credits.
  const verified = await verifyPayment(deps, stage.merchantTransactionId, { clientIp });

  // 7 and 8. Read the row again (it may be in review now) and write the audit row.
  return deps.run(async (tx): Promise<RecheckOutcome> => {
    const repos = customerRepos(tx, customerId);
    const row = await repos.payments.get(paymentId);
    if (row === null) return { ok: false, error: "internal" };
    const state = asState(row);
    const written = await repos.audit.record({
      action: "payment.recheck",
      targetType: "payment",
      targetId: paymentId,
      ip: clientIp,
      metadata: { state: verified.ok ? verified.value.state : verified.error },
    });
    if (!written.ok) throw new Error("recheck: the audit row was refused");
    if (!verified.ok) return verified;
    safeLog(deps, "eps.recheck", { paymentId, state: verified.value.state });
    return answer(state);
  });
}
