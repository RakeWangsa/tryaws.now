import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import { LEDGER_ACCOUNT_TYPES } from "../schema/money";
import { asInt, asNullableText, asText, toMinor } from "./values";

// One function per statement, `tx` first, plain rows out, bigint for money. The functions take no
// decision: the rules (replay, balance, currency, who may post) belong to @tc/core. Only the `sql`
// template with bound parameters is used: a Drizzle insert() names every column, created_at
// included, and wallets and ledger_accounts then answer 42501 (migration 0006).

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export interface LedgerAccountRow {
  readonly id: string;
  readonly type: LedgerAccountType;
  readonly customerId: string | null;
  readonly currency: string;
}

export interface WalletRow {
  readonly id: string;
  readonly customerId: string;
  readonly currency: string;
  readonly balanceMinor: bigint;
  readonly version: number;
}

type Row = Record<string, unknown>;

function accountType(value: unknown): LedgerAccountType {
  const text = asText(value);
  const known = LEDGER_ACCOUNT_TYPES.find((type) => type === text);
  if (known === undefined) throw new TypeError("ledger: unknown account type");
  return known;
}

function toAccount(row: Row): LedgerAccountRow {
  return {
    id: asText(row.id),
    type: accountType(row.type),
    customerId: asNullableText(row.customer_id),
    currency: asText(row.currency),
  };
}

function toWallet(row: Row): WalletRow {
  return {
    id: asText(row.id),
    customerId: asText(row.customer_id),
    currency: asText(row.currency),
    balanceMinor: toMinor(row.balance_minor),
    version: asInt(row.version),
  };
}

export async function findPlatformAccounts(
  tx: Tx,
  currency: string,
  types: readonly LedgerAccountType[],
): Promise<LedgerAccountRow[]> {
  if (types.length === 0) return [];
  const list = sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  );
  const result = await tx.execute(
    sql`select id, type, customer_id, currency from ledger_accounts where customer_id is null and currency = ${currency} and type in (${list})`,
  );
  return (result.rows as Row[]).map(toAccount);
}

export async function findWalletAccount(
  tx: Tx,
  customerId: string,
  currency: string,
): Promise<LedgerAccountRow | null> {
  const result = await tx.execute(
    sql`select id, type, customer_id, currency from ledger_accounts where customer_id = ${customerId} and type = 'customer_wallet' and currency = ${currency}`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toAccount(row);
}

// The new id, or null when the account exists.
export async function insertPlatformAccount(
  tx: Tx,
  type: Exclude<LedgerAccountType, "customer_wallet">,
  currency: string,
): Promise<string | null> {
  const id = uuidv7();
  const result = await tx.execute(
    sql`insert into ledger_accounts (id, type, customer_id, currency) values (${id}, ${type}, null, ${currency}) on conflict on constraint ledger_accounts_customer_id_type_currency_unique do nothing returning id`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : asText(row.id);
}

export async function insertWalletAccount(
  tx: Tx,
  customerId: string,
  currency: string,
): Promise<string | null> {
  const id = uuidv7();
  const result = await tx.execute(
    sql`insert into ledger_accounts (id, type, customer_id, currency) values (${id}, 'customer_wallet', ${customerId}, ${currency}) on conflict on constraint ledger_accounts_customer_id_type_currency_unique do nothing returning id`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : asText(row.id);
}

export async function insertWallet(
  tx: Tx,
  customerId: string,
  currency: string,
): Promise<string | null> {
  const id = uuidv7();
  const result = await tx.execute(
    sql`insert into wallets (id, customer_id, currency) values (${id}, ${customerId}, ${currency}) on conflict (customer_id) do nothing returning id`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : asText(row.id);
}

export async function customerMarketCurrency(tx: Tx, customerId: string): Promise<string | null> {
  const result = await tx.execute(
    sql`select m.currency from customers c join markets m on m.code = c.market where c.id = ${customerId}`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : asText(row.currency);
}

export async function readWalletRow(tx: Tx, customerId: string): Promise<WalletRow | null> {
  const result = await tx.execute(
    sql`select id, customer_id, currency, balance_minor, version from wallets where customer_id = ${customerId}`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toWallet(row);
}

// FOR UPDATE: the row stays locked until the transaction ends.
export async function lockWalletRow(tx: Tx, customerId: string): Promise<WalletRow | null> {
  const result = await tx.execute(
    sql`select id, customer_id, currency, balance_minor, version from wallets where customer_id = ${customerId} for update`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toWallet(row);
}

// The guarded cache update. $3 is the same number as text, cast to numeric, so the test cannot
// overflow. The new cache value, or null when the result would be below 0 or past the bigint range
// (or the wallet is unknown).
export async function addToWallet(
  tx: Tx,
  walletId: string,
  deltaMinor: bigint,
): Promise<bigint | null> {
  const result = await tx.execute(
    sql`update wallets set balance_minor = balance_minor + ${deltaMinor}::bigint, version = version + 1 where id = ${walletId} and balance_minor::numeric + ${deltaMinor.toString()}::numeric between 0 and 9223372036854775807 returning balance_minor`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toMinor(row.balance_minor);
}

// Credits minus debits on the wallet account; null for an unknown wallet.
export async function sumWalletEntries(tx: Tx, walletId: string): Promise<bigint | null> {
  const result = await tx.execute(
    sql`select coalesce(sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end), 0) as net from wallets w left join ledger_accounts a on a.customer_id = w.customer_id and a.type = 'customer_wallet' and a.currency = w.currency left join ledger_entries e on e.account_id = a.id where w.id = ${walletId} group by w.id`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : toMinor(row.net);
}
