import {
  addToWallet,
  findLedgerTransactionByKey,
  findPlatformAccounts,
  findWalletAccount,
  insertLedgerEntries,
  insertLedgerTransaction,
  lockWalletRow,
  type NewLedgerEntry,
  type StoredLedgerTransaction,
  type Tx,
  type WalletRow,
} from "@tc/db";
import type { Result } from "../types";
import { LedgerError } from "./errors";
import { checkPosting, samePosting, type NormalizedPosting } from "./rules";
import type { PlatformAccountType, PostTransactionInput } from "./types";

export interface WriteOptions {
  /**
   * Called under the wallet lock, after the key was looked up and not found, before the balance check.
   * A returned id is the transaction of an earlier request that did the same work under another key:
   * the answer is `{ ok: true, value: { transactionId: <that id> } }` and nothing is written.
   */
  readonly findEarlier?: (tx: Tx) => Promise<string | null>;
}

type Posted = Result<{ transactionId: string }>;

/** F: check the request (no query), then write it. */
export async function postTransaction(tx: Tx, input: PostTransactionInput): Promise<Posted> {
  const checked = checkPosting(input);
  if (!checked.ok) return { ok: false, error: checked.error, fields: checked.fields };
  return writePosting(tx, checked.value);
}

/**
 * Writes a checked posting. The order of the steps is the design: every `return` before step 5 has
 * written nothing, because a header without lines fails the COMMIT of the transaction (23514).
 */
export async function writePosting(
  tx: Tx,
  p: NormalizedPosting,
  options?: WriteOptions,
): Promise<Posted> {
  // step 1: lock
  let wallet: WalletRow | null = null;
  if (p.walletCustomerId !== null) {
    wallet = await lockWalletRow(tx, p.walletCustomerId);
    if (wallet === null) return { ok: false, error: "not_found" };
    if (wallet.currency !== p.currency) return { ok: false, error: "conflict" };
  }

  // step 2: accounts
  const types = [
    ...new Set(
      p.lines.flatMap((line) =>
        line.account.type === "customer_wallet" ? [] : [line.account.type],
      ),
    ),
  ] as PlatformAccountType[];
  const platform = await findPlatformAccounts(tx, p.currency, types);
  if (platform.length < types.length) return { ok: false, error: "internal" };
  let walletAccountId: string | null = null;
  if (p.walletCustomerId !== null) {
    const account = await findWalletAccount(tx, p.walletCustomerId, p.currency);
    if (account === null) return { ok: false, error: "not_found" };
    walletAccountId = account.id;
  }
  const lines: NewLedgerEntry[] = p.lines.map((line) => {
    const accountId =
      line.account.type === "customer_wallet"
        ? walletAccountId
        : (platform.find((a) => a.type === line.account.type)?.id ?? null);
    if (accountId === null) throw new LedgerError("invariant");
    return { accountId, direction: line.direction, amountMinor: line.amountMinor };
  });
  const wanted = {
    kind: p.kind,
    referenceType: p.referenceType,
    referenceId: p.referenceId,
    lines,
  };
  const answerFor = (stored: StoredLedgerTransaction): Posted =>
    samePosting(
      {
        kind: stored.kind,
        referenceType: stored.referenceType,
        referenceId: stored.referenceId,
        lines: stored.entries.map((e) => ({
          accountId: e.accountId,
          direction: e.direction,
          amountMinor: e.amountMinor,
        })),
      },
      wanted,
    )
      ? { ok: true, value: { transactionId: stored.id } }
      : { ok: false, error: "conflict" };

  // step 3: key
  const existing = await findLedgerTransactionByKey(tx, p.idempotencyKey);
  if (existing !== null) return answerFor(existing);
  if (options?.findEarlier !== undefined) {
    const earlier = await options.findEarlier(tx);
    if (earlier !== null) return { ok: true, value: { transactionId: earlier } };
  }

  // step 4: balance
  if (wallet !== null && wallet.balanceMinor + p.walletDelta < 0n) {
    return {
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: -(wallet.balanceMinor + p.walletDelta) },
    };
  }

  // step 5: header
  const id = await insertLedgerTransaction(tx, {
    kind: p.kind,
    referenceType: p.referenceType,
    referenceId: p.referenceId,
    idempotencyKey: p.idempotencyKey,
    actorType: p.actor.type,
    actorId: p.actor.id,
    memo: p.memo,
  });
  if (id === null) {
    const taken = await findLedgerTransactionByKey(tx, p.idempotencyKey);
    if (taken === null) throw new LedgerError("invariant");
    return answerFor(taken);
  }

  // step 6: lines and cache
  await insertLedgerEntries(tx, id, lines);
  if (wallet !== null) {
    if ((await addToWallet(tx, wallet.id, p.walletDelta)) === null) {
      throw new LedgerError("invariant");
    }
  }
  return { ok: true, value: { transactionId: id } };
}
