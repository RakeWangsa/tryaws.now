import { findLedgerTransactionById, findReversalOf, type Tx } from "@tc/db";
import type { Result } from "../types";
import { ledgerKey } from "./keys";
import { writePosting } from "./post";
import { checkPosting, reversePostings, type NormalizedLine } from "./rules";
import type { Actor } from "./types";
import { isUuid } from "./uuid";

// Spec 9.1 and R5: a correction is a new transaction, the same accounts reversed. The original is
// never touched. A transaction is reversed at most once, whoever asks and under whichever of the two
// key families: the unique key holds within one family, `findEarlier` (under the wallet lock) across both.

export interface ReverseTransactionInput {
  /** The ledger transaction to reverse. */
  readonly transactionId: string;
  /** The automatic reversal of a failed create (WP4-T4): the key is the key of 9.1, `order-reversal:<order id>`. */
  readonly orderId?: string;
  readonly actor: Actor;
  readonly memo?: string;
}

export async function reverseTransaction(
  tx: Tx,
  input: ReverseTransactionInput,
): Promise<Result<{ transactionId: string }>> {
  // step 1: the ids
  if (!isUuid(input.transactionId)) {
    return {
      ok: false,
      error: "validation",
      fields: { transactionId: "The transaction id must be a UUID." },
    };
  }
  if (input.orderId !== undefined && !isUuid(input.orderId)) {
    return {
      ok: false,
      error: "validation",
      fields: { orderId: "The order id must be a UUID." },
    };
  }
  const originalId = input.transactionId.toLowerCase();

  // step 2: the original
  const original = await findLedgerTransactionById(tx, originalId);
  if (original === null) return { ok: false, error: "not_found" };
  if (original.kind === "reversal") {
    return {
      ok: false,
      error: "validation",
      fields: { transactionId: "A reversal cannot be reversed." },
    };
  }

  // step 3: the inverse lines, checked like any other posting (kind, key family, actor, reason)
  const lines: NormalizedLine[] = original.entries.map((entry) => ({
    account: {
      type: entry.accountType,
      customerId: entry.accountCustomerId,
      currency: entry.currency,
    },
    direction: entry.direction,
    amountMinor: entry.amountMinor,
  }));
  const checked = checkPosting(
    {
      kind: "reversal",
      reference: { type: "ledger_transaction", id: original.id },
      idempotencyKey:
        input.orderId === undefined
          ? ledgerKey.reversal(original.id)
          : ledgerKey.orderReversal(input.orderId),
      actor: input.actor,
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      postings: reversePostings(lines),
    },
    { allowReversal: true },
  );
  if (!checked.ok) return { ok: false, error: checked.error, fields: checked.fields };

  // step 4: lock, key, the reversal under the other key family, balance, writes
  return writePosting(tx, checked.value, { findEarlier: (t) => findReversalOf(t, original.id) });
}
