import type { Result } from "../types";
import { makeOrders, type Orders } from "./place";
import type { OrdersDeps } from "./draft";
import type { OrderDraft, OrderSession } from "./types";

/**
 * The dependencies of the bound functions of F. They need the draft secret list, which the
 * infrastructure generates and links to the web function only (WP0-T4), and a transaction runner
 * and a queue. No wrapper for them exists yet, and this package reads nothing from the
 * environment (R3), so the bare bindings refuse (R16) until WP4-T7 supplies the wiring (open
 * point 2).
 */
export function productionDeps(): OrdersDeps {
  throw new Error("orders: not configured");
}

let bound: Orders | undefined;

/** Built on the first call, never at import: importing @tc/core must work without secrets. */
function orders(): Orders {
  bound ??= makeOrders(productionDeps());
  return bound;
}

/** F: createOrderDraft, bound to `makeOrders(productionDeps())`. */
export async function createOrderDraft(
  session: OrderSession,
  input: unknown,
): Promise<Result<OrderDraft>> {
  return orders().createOrderDraft(session, input);
}

/** F: placeOrder, bound to `makeOrders(productionDeps())`. */
export async function placeOrder(
  session: OrderSession,
  input: { token: string; idempotencyKey: string },
): Promise<Result<{ orderId: string }>> {
  return orders().placeOrder(session, input);
}
