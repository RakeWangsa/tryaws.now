import { compensationRepo, type Tx } from "@tc/db";
import { releaseCapacity } from "../capacity/release";
import { lockWallet } from "../ledger/balance";
import { reverseTransaction } from "../ledger/reverse";
import type { Clock } from "../types";

export interface Compensated {
  /** The order is reversed after the call: the refund exists, posted now or earlier. */
  readonly reversed: boolean;
  /** This call gave the capacity back. */
  readonly released: boolean;
  /** This call changed nothing in the order: another call or an admin was first. */
  readonly replayed: boolean;
}

// The code is an engine word (`validation:InvalidInputException`, `rejected`). Anything else is
// replaced, so a memo can never hold customer text (R14).
// Fixed text: no id, no state, no amount in the message (R14).
const NOT_REVERSIBLE = "orders: a failed create cannot be reversed in this state";
const ENGINE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * The automatic reversal of a failed create (10.1): one reversing ledger transaction keyed
 * `order-reversal:<order id>`, the order `reversed`, the subscription `ended`, the resource `failed`
 * and the capacity given back once. It runs in the transaction that moves the operation to `failed`
 * (as worker_rw): a throw rolls the whole move back, and the sweeper recovers the run. The money is
 * more important than the state, so a reversal that cannot be posted throws (R16). The customer's
 * gates are not applied: a customer whose KYC was revoked still gets the refund.
 *
 * Lock order is the purchase's: the wallet row first, then the resource row and the capacity cells.
 */
export async function compensateFailedCreate(
  tx: Tx,
  deps: { readonly clock: Clock },
  event: { readonly resourceId: string; readonly customerId: string; readonly code: string },
): Promise<Compensated> {
  await lockWallet(tx, event.customerId);
  const repo = compensationRepo(tx, event.customerId);

  const order = await repo.findOrderOfResource(event.resourceId);
  // A create without an order must never be silent (R16): the sweeper escalates.
  if (order === null || order.customerId !== event.customerId) {
    throw new Error("orders: a failed create has no order");
  }

  // Money moves back only for an order that is still paid. A reversed order is the idempotent no-op
  // below; any other status (a fulfilled order) is a refund of a service that exists, so it throws a
  // fixed text and the sweeper escalates (R16). Nothing has been written yet.
  if (order.status !== "paid" && order.status !== "reversed") throw new Error(NOT_REVERSIBLE);

  // The release needs the state `failed`. For a paid order the resource must be `creating` or
  // `failed` already: a resource that became active is never refunded by a stale failed event.
  const failed = await repo.failResource(event.resourceId);
  if (!failed && order.status === "paid") throw new Error(NOT_REVERSIBLE);

  const code = ENGINE_CODE.test(event.code) ? event.code : "unknown";
  const reversal = await reverseTransaction(tx, {
    transactionId: order.ledgerTransactionId,
    orderId: order.orderId,
    actor: { type: "system" },
    memo: `automatic reversal of a failed create: ${code}`,
  });
  // A reversal that already exists (this key or an admin's) comes back ok and posts nothing.
  if (!reversal.ok) throw new Error("orders: the automatic reversal was refused");

  const flipped = await repo.markOrderReversed(order.orderId);
  await repo.endSubscription(event.resourceId);

  // The refund stands whatever the release says (10.1): released:false is not a failure.
  const released = await releaseCapacity(tx, {
    resourceId: event.resourceId,
    clock: deps.clock,
  });
  if (!released.ok) throw new Error("orders: the capacity release failed");

  return { reversed: true, released: released.value.released, replayed: !flipped };
}
