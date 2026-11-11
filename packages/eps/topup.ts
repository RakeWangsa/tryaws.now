import type { Minor, Result } from "@tc/core";
import { consumeRateLimits, customerRepos, readMarket } from "@tc/db";
import type { PaymentRow } from "@tc/db";
import type { EpsDeps } from "./deps";
import type { InitializeResult } from "./gateway";
import { newMerchantTransactionId } from "./ids";
import { START_LIMITS, ipSubject } from "./limits";
import { safeLog } from "./log";

/** What the Server Action passes: the idempotency key is the browser's, the customer is never in the input (R8). */
export interface TopUpInput {
  amountMinor: Minor;
  idempotencyKey: string;
}

/** The request context. The address is not part of contract F's input (open point 16). */
export interface TopUpContext {
  clientIp: string;
}

export type TopUpResult = Result<{ paymentId: string; redirectUrl: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const PRODUCT_NAME = "Wallet top-up";
const GATEWAY_ID_MAX = 128;

type Stage = { kind: "done"; result: TopUpResult } | { kind: "created"; payment: PaymentRow };

/**
 * F: startTopUp, in the order of R9. The row is stored before EPS is called, so a crash between the
 * two leaves a row the sweeper settles, never an EPS payment without a row. The one InitializeEPS
 * call per row is never retried (open point 6.7). No error text of a dependency is passed on (R14).
 */
export async function startTopUp(
  deps: EpsDeps,
  s: { readonly customerId: string },
  input: TopUpInput,
  ctx: TopUpContext,
): Promise<TopUpResult> {
  try {
    return await start(deps, s, input, ctx);
  } catch {
    // R16: whatever threw (a database error, a TypeError of a repository), nothing was promised.
    safeLog(deps, "eps.start", { reason: "exception" });
    return { ok: false, error: "internal" };
  }
}

async function start(
  deps: EpsDeps,
  s: { readonly customerId: string },
  input: TopUpInput,
  ctx: TopUpContext,
): Promise<TopUpResult> {
  // 1. authenticate: the session is the caller's; only its customer id is used.
  const customerId = s?.customerId;
  if (typeof customerId !== "string" || !UUID.test(customerId)) {
    return { ok: false, error: "unauthenticated" };
  }

  // 2. validate (by hand, no zod installed). Extra keys of input are ignored: nothing reads them.
  const amountMinor = input?.amountMinor;
  const idempotencyKey = input?.idempotencyKey;
  const clientIp = ctx?.clientIp;
  const fields: Record<string, string> = {};
  if (typeof amountMinor !== "bigint" || amountMinor <= 0n) fields.amount = "invalid";
  if (typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) {
    fields.idempotencyKey = "invalid";
  }
  const subject = ipSubject(deps.limitKey, clientIp);
  if (subject === null) fields.clientIp = "invalid";
  if (
    Object.keys(fields).length > 0 ||
    typeof amountMinor !== "bigint" ||
    typeof idempotencyKey !== "string" ||
    subject === null ||
    typeof clientIp !== "string"
  ) {
    return { ok: false, error: "validation", fields };
  }

  // 3 and 4. One transaction: the market range, the rate limits, then the row.
  const now = deps.clock.now();
  const stage = await deps.run<Stage>(async (tx): Promise<Stage> => {
    const repos = customerRepos(tx, customerId);
    const profile = await repos.profile.get();
    if (profile === null) return { kind: "done", result: { ok: false, error: "not_found" } };
    const market = await readMarket(tx, profile.market);
    if (market === null || !market.active) {
      return { kind: "done", result: { ok: false, error: "forbidden" } };
    }
    if (amountMinor < market.topupMinMinor || amountMinor > market.topupMaxMinor) {
      return {
        kind: "done",
        result: { ok: false, error: "validation", fields: { amount: "out_of_range" } },
      };
    }

    // Rate limit. A refusal returns (it does not throw), so the counters stay and a hammering client
    // keeps being refused; no payment row is stored.
    const byCustomer = await repos.rateLimits.consume(START_LIMITS.customer, now);
    if (!byCustomer.allowed) {
      return {
        kind: "done",
        result: {
          ok: false,
          error: "rate_limited",
          data: { retryAfterSeconds: byCustomer.retryAfterSeconds },
        },
      };
    }
    const byIp = await consumeRateLimits(tx, [{ kind: "ip", subject, ...START_LIMITS.ip }], now);
    if (!byIp.allowed) {
      return {
        kind: "done",
        result: {
          ok: false,
          error: "rate_limited",
          data: { retryAfterSeconds: byIp.retryAfterSeconds },
        },
      };
    }

    const written = await repos.payments.insert({
      id: deps.newPaymentId(),
      merchantTransactionId: newMerchantTransactionId(deps.randomBytes),
      idempotencyKey,
      amountMinor,
      currency: market.currency,
      gateway: "eps",
    });
    if (!written.ok) {
      return {
        kind: "done",
        result: {
          ok: false,
          error: written.error === "conflict" ? "conflict" : "internal",
        },
      };
    }
    if (written.replayed) {
      // R7: the same request again. No EPS call; the screen sends the customer to that payment (open point 7).
      return {
        kind: "done",
        result: { ok: false, error: "conflict", ref: written.value.id },
      };
    }
    return { kind: "created", payment: written.value };
  });
  if (stage.kind === "done") return stage.result;
  const payment = stage.payment;

  // 5. Outside any transaction: one InitializeEPS call.
  let answer: InitializeResult;
  try {
    answer = await deps.gateway.initialize({
      merchantTransactionId: payment.merchantTransactionId,
      customerOrderId: payment.id,
      totalAmountMinor: payment.amountMinor,
      ipAddress: clientIp,
      productName: PRODUCT_NAME,
      successUrl: deps.urls.successUrl,
      failUrl: deps.urls.failUrl,
      cancelUrl: deps.urls.cancelUrl,
    });
  } catch {
    answer = { ok: false, reason: "unavailable" };
    safeLog(deps, "eps.start", { paymentId: payment.id, reason: "gateway_threw" });
  }

  // 6 and 7. Settle the row and write the audit row in one short transaction.
  if (answer.ok) {
    const gatewayId =
      answer.gatewayTransactionId !== null &&
      answer.gatewayTransactionId.length >= 1 &&
      answer.gatewayTransactionId.length <= GATEWAY_ID_MAX
        ? answer.gatewayTransactionId
        : null;
    const moved = await deps
      .run(async (tx) => {
        const repos = customerRepos(tx, customerId);
        const ok = await repos.payments.markRedirected(payment.id, gatewayId);
        if (ok) await audit(repos, payment, clientIp, "redirected");
        return ok;
      })
      .catch(() => false);
    if (!moved) {
      // The row could not be marked (a concurrent change or a database error). The customer does not
      // get a link to a payment we cannot account for; the sweeper settles the row (R16).
      safeLog(deps, "eps.start", { paymentId: payment.id, reason: "mark_redirected_failed" });
      return { ok: false, error: "upstream_unavailable" };
    }
    safeLog(deps, "eps.start", { paymentId: payment.id, state: "redirected" });
    return { ok: true, value: { paymentId: payment.id, redirectUrl: answer.redirectUrl } };
  }

  try {
    await deps.run(async (tx) => {
      const repos = customerRepos(tx, customerId);
      const state = answer.reason === "rejected" ? "failed" : "initiated";
      if (answer.reason === "rejected") await repos.payments.markFailed(payment.id);
      await audit(repos, payment, clientIp, state);
    });
  } catch {
    safeLog(deps, "eps.start", { paymentId: payment.id, reason: "settle_failed" });
  }
  safeLog(deps, "eps.start", { paymentId: payment.id, reason: answer.reason });
  return { ok: false, error: "upstream_unavailable" };
}

async function audit(
  repos: ReturnType<typeof customerRepos>,
  payment: PaymentRow,
  clientIp: string,
  state: string,
): Promise<void> {
  // The audit row holds the payment id and the amount; never the URL (R14).
  await repos.audit.record({
    action: "payment.start",
    targetType: "payment",
    targetId: payment.id,
    ip: clientIp,
    metadata: { amountMinor: payment.amountMinor.toString(), state },
  });
}
