import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { asInt, asText, toMinor } from "./values";

// The read-only queries of the nightly balance check. Each one answers the rows that break a rule
// (cut at `limit`) and `total`, the number of rows that match. `count(*) over ()` is evaluated
// before `limit`, so every row carries the total; no row means a total of 0. The functions take no
// decision and write nothing; the caller (the job) decides what a finding means. The queries run
// one after another on the one `tx`.

export interface LedgerCounted<T> {
  readonly total: number;
  readonly rows: readonly T[];
}
export interface WalletDifference {
  readonly walletId: string;
  readonly customerId: string;
  readonly cachedMinor: bigint;
  readonly entriesMinor: bigint;
}
export interface OrphanWalletAccount {
  readonly accountId: string;
  readonly customerId: string;
  readonly entriesMinor: bigint;
}
/** Debits minus credits of one transaction in one currency. */
export interface UnbalancedTransaction {
  readonly transactionId: string;
  readonly currency: string;
  readonly netMinor: bigint;
}
export interface OneSidedTransaction {
  readonly transactionId: string;
  readonly hasDebit: boolean;
  readonly hasCredit: boolean;
}
export interface LedgerTotals {
  readonly wallets: number;
  readonly transactions: number;
  readonly entries: number;
}

type Row = Record<string, unknown>;

const MAX_LIMIT = 1000;

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError("ledger: the limit is not an integer from 1 to 1000");
  }
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new TypeError("ledger: not a boolean value");
}

// The total of a result: every row carries it, no row means 0.
function totalOf(rows: Row[]): number {
  const first = rows[0];
  return first === undefined ? 0 : asInt(first.total);
}

// One row per wallet with the sum of the entries of its ledger account (same customer, type
// customer_wallet, same currency).
const WALLET_NET = sql`select w.id as wallet_id, w.customer_id, w.balance_minor as cached, coalesce(s.net, 0) as entries
    from wallets w
    left join ledger_accounts a on a.customer_id = w.customer_id and a.type = 'customer_wallet' and a.currency = w.currency
    left join lateral (select sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end) as net
                         from ledger_entries e where e.account_id = a.id) s on true`;

function toWalletDifference(row: Row): WalletDifference {
  return {
    walletId: asText(row.wallet_id),
    customerId: asText(row.customer_id),
    cachedMinor: toMinor(row.cached),
    entriesMinor: toMinor(row.entries),
  };
}

// The cache of the wallet is not the sum of its entries.
export async function walletMismatches(
  tx: Tx,
  limit: number,
): Promise<LedgerCounted<WalletDifference>> {
  checkLimit(limit);
  const result = await tx.execute(
    sql`select x.*, count(*) over () as total from (${WALLET_NET}) x where x.cached <> x.entries order by x.wallet_id limit ${limit}`,
  );
  const rows = result.rows as Row[];
  return { total: totalOf(rows), rows: rows.map(toWalletDifference) };
}

// The cache or the sum of the entries of a wallet is below 0.
export async function negativeWallets(
  tx: Tx,
  limit: number,
): Promise<LedgerCounted<WalletDifference>> {
  checkLimit(limit);
  const result = await tx.execute(
    sql`select x.*, count(*) over () as total from (${WALLET_NET}) x where x.cached < 0 or x.entries < 0 order by x.wallet_id limit ${limit}`,
  );
  const rows = result.rows as Row[];
  return { total: totalOf(rows), rows: rows.map(toWalletDifference) };
}

// A customer wallet account that has entries and no wallet of the same customer and currency.
export async function walletAccountsWithoutWallet(
  tx: Tx,
  limit: number,
): Promise<LedgerCounted<OrphanWalletAccount>> {
  checkLimit(limit);
  const result = await tx.execute(
    sql`select a.id as account_id, a.customer_id, sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end) as entries, count(*) over () as total
    from ledger_accounts a join ledger_entries e on e.account_id = a.id
   where a.type = 'customer_wallet' and not exists (select 1 from wallets w where w.customer_id = a.customer_id and w.currency = a.currency)
   group by a.id, a.customer_id order by a.id limit ${limit}`,
  );
  const rows = result.rows as Row[];
  return {
    total: totalOf(rows),
    rows: rows.map((row) => ({
      accountId: asText(row.account_id),
      customerId: asText(row.customer_id),
      entriesMinor: toMinor(row.entries),
    })),
  };
}

// A transaction whose debits and credits differ in one currency.
export async function unbalancedTransactions(
  tx: Tx,
  limit: number,
): Promise<LedgerCounted<UnbalancedTransaction>> {
  checkLimit(limit);
  const result = await tx.execute(
    sql`select e.transaction_id, a.currency, sum(case e.direction when 'debit' then e.amount_minor else -e.amount_minor end) as net, count(*) over () as total
    from ledger_entries e join ledger_accounts a on a.id = e.account_id
   group by e.transaction_id, a.currency having sum(case e.direction when 'debit' then e.amount_minor else -e.amount_minor end) <> 0
   order by e.transaction_id, a.currency limit ${limit}`,
  );
  const rows = result.rows as Row[];
  return {
    total: totalOf(rows),
    rows: rows.map((row) => ({
      transactionId: asText(row.transaction_id),
      currency: asText(row.currency),
      netMinor: toMinor(row.net),
    })),
  };
}

// A transaction that has no debit line or no credit line (a header with no lines included).
export async function oneSidedTransactions(
  tx: Tx,
  limit: number,
): Promise<LedgerCounted<OneSidedTransaction>> {
  checkLimit(limit);
  const result = await tx.execute(
    sql`select t.id as transaction_id,
         exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'debit') as has_debit,
         exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'credit') as has_credit,
         count(*) over () as total
    from ledger_transactions t
   where not exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'debit')
      or not exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.direction = 'credit')
   order by t.id limit ${limit}`,
  );
  const rows = result.rows as Row[];
  return {
    total: totalOf(rows),
    rows: rows.map((row) => ({
      transactionId: asText(row.transaction_id),
      hasDebit: asBool(row.has_debit),
      hasCredit: asBool(row.has_credit),
    })),
  };
}

export async function ledgerTotals(tx: Tx): Promise<LedgerTotals> {
  const result = await tx.execute(
    sql`select (select count(*) from wallets) as wallets, (select count(*) from ledger_transactions) as transactions, (select count(*) from ledger_entries) as entries`,
  );
  const row = (result.rows as Row[])[0];
  if (row === undefined) throw new TypeError("ledger: the totals query returned no row");
  return {
    wallets: asInt(row.wallets),
    transactions: asInt(row.transactions),
    entries: asInt(row.entries),
  };
}

// `select current_user`: the nightly job refuses to run under another role than worker_rw.
export async function currentDatabaseUser(tx: Tx): Promise<string> {
  const result = await tx.execute(sql`select current_user as name`);
  const row = (result.rows as Row[])[0];
  if (row === undefined) throw new TypeError("ledger: the user query returned no row");
  return asText(row.name);
}
