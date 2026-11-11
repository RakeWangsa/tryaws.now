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
  const repo = compensationRepo(tx);

  const order = await repo.findOrderOfResource(event.resourceId);
  // A create without an order must never be silent (R16): the sweeper escalates.
  if (order === null || order.customerId !== event.customerId) {
    throw new Error("orders: a failed create has no order");
  }

  // The release needs the state `failed`.
  await repo.failResource(event.resourceId);

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
