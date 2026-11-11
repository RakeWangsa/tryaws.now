import { customerRepos, type CustomerLimit } from "@tc/db";
import { firstMessage, sendAfterCommit } from "../operations/index";
import { snapshotToQuote } from "../pricing/index";
import type { Result } from "../types";
import { createDraft, type OrdersDeps } from "./draft";
import { INTERNAL, runGuarded } from "./guard";
import { draftHash } from "./ids";
import { runPurchase } from "./purchase";
import { assertSecrets, signDraft, verifyDraft } from "./token";
import {
  CLIENT_KEY,
  DRAFT_MAX_BYTES,
  type DraftClaims,
  type OrderDraft,
  type OrderSession,
} from "./types";

/** F: the two functions of packages/core/orders, with their dependencies bound. */
export interface Orders {
  createOrderDraft(s: OrderSession, input: unknown): Promise<Result<OrderDraft>>;
  placeOrder(
    s: OrderSession,
    input: { token: string; idempotencyKey: string },
  ): Promise<Result<{ orderId: string }>>;
}

/**
 * Ten placements a minute and 60 an hour per customer (open point 13). The count is not given back
 * when a later step refuses: a refused call is still a call.
 */
export const ORDER_RATE_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "order.place", limit: 10, windowSeconds: 60 }),
  Object.freeze({ action: "order.place", limit: 60, windowSeconds: 3600 }),
]);

function fresh(secrets: readonly Uint8Array[], claims: DraftClaims): OrderDraft {
  return {
    token: signDraft(secrets, claims),
    quote: snapshotToQuote(claims.snap),
    expiresAt: new Date(claims.exp * 1000),
  };
}

/**
 * The factory of `createOrderDraft` and `placeOrder`. The clock, the secrets, the queue and the
 * transaction runner are injected; nothing is read from the environment (R3). It throws at once
 * for an empty or short secret list.
 */
export function makeOrders(deps: OrdersDeps): Orders {
  assertSecrets(deps.secrets);

  async function placeOrder(
    session: OrderSession,
    input: { token: string; idempotencyKey: string },
  ): Promise<Result<{ orderId: string }>> {
    // R9, 1: authorize and validate, with no query. The Server Action has authenticated.
    const record = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const { token, idempotencyKey } = record;
    const fields: Record<string, string> = {};
    if (typeof token !== "string" || token.length === 0 || token.length > DRAFT_MAX_BYTES) {
      fields.token = "invalid";
    }
    if (typeof idempotencyKey !== "string" || !CLIENT_KEY.test(idempotencyKey)) {
      fields.idempotencyKey = "invalid";
    }
    if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
    const text = token as string;
    const clientKey = idempotencyKey as string;

    const now = deps.clock.now();
    const verdict = verifyDraft(deps.secrets, text, now);
    if (!verdict.ok) {
      return {
        ok: false,
        error: "validation",
        fields: { token: verdict.reason === "expired" ? "expired" : "invalid" },
      };
    }
    const claims = verdict.claims;
    // Accepted only from the customer it names. Nothing else is checked and no query is sent.
    if (claims.c !== session.customerId) return { ok: false, error: "forbidden" };

    // R9, 2: rate limit, in a short transaction of its own that commits whatever follows.
    // A database error in either transaction is `internal` and says nothing (R14, R16).
    const limited = await runGuarded(deps, (tx) =>
      customerRepos(tx, session.customerId).rateLimits.consume(ORDER_RATE_LIMITS, now),
    );
    if (!limited.done) return INTERNAL;
    const decision = limited.value;
    if (!decision.allowed) {
      return {
        ok: false,
        error: "rate_limited",
        data: { retryAfterSeconds: decision.retryAfterSeconds },
      };
    }

    // R9, 3: execute. The audit entry of the purchase is the audit of the success.
    const executed = await runGuarded(deps, (tx) =>
      runPurchase(tx, deps, {
        claims,
        tokenHash: draftHash(text),
        clientKey,
        customerId: session.customerId,
      }),
    );
    if (!executed.done) return INTERNAL;
    const result = executed.value;
    if (!result.ok) {
      if (result.error === "price_changed") {
        // A new draft for the same configuration at the new price; the old token is never reused.
        const data = result.data as { claims: DraftClaims };
        return { ok: false, error: "price_changed", data: fresh(deps.secrets, data.claims) };
      }
      return result;
    }

    // After the commit. The result never depends on the queue: a lost message is sent again by the
    // scheduler (the operation row has enqueue_seq 0). A replay sends nothing.
    const purchased = result.value;
    if (!purchased.replayed) {
      const sent = await sendAfterCommit(
        deps.queue,
        firstMessage(purchased.operationId, purchased.resourceId),
      );
      if (!sent) deps.log?.({ event: "orders.queue_send_failed" });
    }
    return { ok: true, value: { orderId: purchased.orderId } };
  }

  return {
    // createDraft guards its own transaction: the draft function is exported for tests as well.
    createOrderDraft: (session, input) => createDraft(deps, session, input),
    placeOrder,
  };
}
