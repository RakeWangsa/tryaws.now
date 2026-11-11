import { v7 as uuidv7 } from "uuid";
import {
  addToWallet,
  findLedgerTransactionByKey,
  findPlatformAccounts,
  findWalletAccount,
  insertLedgerEntries,
  insertLedgerTransaction,
  lockWalletRow,
  type NewLedgerEntry,
} from "../ledger/index";
import type { LedgerPoster } from "../repositories/admin/ledger-port";
import { newCustomer, systemAccount } from "./fixtures";
import type pg from "pg";
import { inTransaction, insertRow, type Queryable } from "./sql";

// The poster of the repository tests. packages/db never imports @tc/core, so this is a small stand-in
// that follows the same steps as postTransaction (wallet lock, key replay, balance, header, lines,
// cache) with the statements of packages/db/ledger. The real postTransaction is exercised against the
// same repositories in packages/core/test/admin-money.db.test.ts.
export const testPoster: LedgerPoster = async (tx, request) => {
  const wallet = request.postings.find((p) => p.account.type === "customer_wallet");
  const customerId = wallet?.account.type === "customer_wallet" ? wallet.account.customerId : null;
  if (customerId === null) return { ok: false, error: "validation" };
  const row = await lockWalletRow(tx, customerId);
  if (row === null) return { ok: false, error: "not_found" };
  const earlier = await findLedgerTransactionByKey(tx, request.idempotencyKey);
  if (earlier !== null) return { ok: true, value: { transactionId: earlier.id } };
  const delta = request.postings.reduce(
    (sum, p) =>
      p.account.type === "customer_wallet"
        ? sum + (p.direction === "credit" ? p.amountMinor : -p.amountMinor)
        : sum,
    0n,
  );
  if (row.balanceMinor + delta < 0n) return { ok: false, error: "insufficient_balance" };
  const platform = await findPlatformAccounts(
    tx,
    row.currency,
    request.postings.flatMap((p) => (p.account.type === "customer_wallet" ? [] : [p.account.type])),
  );
  const walletAccount = await findWalletAccount(tx, customerId, row.currency);
  if (walletAccount === null) return { ok: false, error: "internal" };
  const lines: NewLedgerEntry[] = request.postings.map((p) => ({
    accountId:
      p.account.type === "customer_wallet"
        ? walletAccount.id
        : (platform.find((a) => a.type === p.account.type)?.id ?? ""),
    direction: p.direction,
    amountMinor: p.amountMinor,
  }));
  const id = await insertLedgerTransaction(tx, {
    kind: request.kind,
    referenceType: request.reference.type,
    referenceId: request.reference.id,
    idempotencyKey: request.idempotencyKey,
    actorType: "admin",
    actorId: request.actor.id,
    memo: request.memo,
  });
  if (id === null) return { ok: false, error: "conflict" };
  await insertLedgerEntries(tx, id, lines);
  await addToWallet(tx, row.id, delta);
  return { ok: true, value: { transactionId: id } };
};

// A poster that refuses with the given code and writes nothing.
export const refusingPoster =
  (error: string): LedgerPoster =>
  async () => ({ ok: false, error });

export interface FundedWallet {
  customerId: string;
  walletId: string;
}

// A customer with a wallet, its ledger accounts and a verified top-up of `balance` paisa, written as
// the owner. The platform accounts of the postings exist too.
export async function fundedWallet(pool: pg.Pool, balance: bigint): Promise<FundedWallet> {
  const customerId = await newCustomer(pool);
  const walletId = await insertRow(pool, "wallets", {
    customer_id: customerId,
    currency: "BDT",
    balance_minor: balance,
  });
  const account = await insertRow(pool, "ledger_accounts", {
    type: "customer_wallet",
    customer_id: customerId,
    currency: "BDT",
  });
  const clearing = await systemAccount(pool, "gateway_clearing");
  await systemAccount(pool, "adjustments");
  await systemAccount(pool, "refunds");
  if (balance > 0n) {
    // The two lines balance only together: one transaction.
    await inTransaction(pool, async (c) => {
      const txId = await insertRow(c, "ledger_transactions", {
        kind: "topup",
        reference_type: "payment",
        reference_id: uuidv7(),
        idempotency_key: "topup:" + uuidv7(),
        actor_type: "system",
      });
      await insertRow(c, "ledger_entries", {
        transaction_id: txId,
        account_id: clearing,
        direction: "debit",
        amount_minor: balance,
      });
      await insertRow(c, "ledger_entries", {
        transaction_id: txId,
        account_id: account,
        direction: "credit",
        amount_minor: balance,
      });
    });
  }
  return { customerId, walletId };
}

// The adjustment approval limit of the market of the customers of the tests (the market BD).
export async function setAdjustmentLimit(pool: Queryable, limit: string | number): Promise<void> {
  await pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values ($1, 'wallet.adjustment_limit_minor', 'BD', 'market', null, $2::jsonb)
     on conflict (key, market, scope, scope_id) do update set value = excluded.value`,
    [uuidv7(), JSON.stringify(limit)],
  );
}

export async function walletOf(
  pool: Queryable,
  customerId: string,
): Promise<{ balance: bigint; entriesSum: bigint }> {
  const { rows } = await pool.query<{ balance: string; sum: string }>(
    `select w.balance_minor::text as balance,
            coalesce(sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end), 0)::text as sum
       from wallets w
       left join ledger_accounts a on a.customer_id = w.customer_id and a.type = 'customer_wallet'
       left join ledger_entries e on e.account_id = a.id
      where w.customer_id = $1
      group by w.id`,
    [customerId],
  );
  return { balance: BigInt(rows[0]?.balance ?? "0"), entriesSum: BigInt(rows[0]?.sum ?? "0") };
}
