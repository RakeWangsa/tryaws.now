import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import { LEDGER_ACCOUNT_TYPES, LEDGER_ACTOR_TYPES, LEDGER_DIRECTIONS } from "../schema/money";
import type { LedgerAccountType } from "./accounts";
import { asNullableText, asText, toMinor } from "./values";

// One function per statement, `tx` first, plain rows out, bigint for money. The functions take no
// decision: replay, balance, currency and who may post belong to @tc/core. created_at is never
// named: the database stamps it (migration 0005).

export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export interface NewLedgerTransaction {
  readonly kind: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly actorType: LedgerActorType;
  readonly actorId: string | null;
  readonly memo: string | null;
}

export interface NewLedgerEntry {
  readonly accountId: string;
  readonly direction: LedgerDirection;
  readonly amountMinor: bigint;
}

export interface StoredLedgerEntry extends NewLedgerEntry {
  readonly id: string;
  readonly accountType: LedgerAccountType;
  readonly accountCustomerId: string | null;
  readonly currency: string;
}

export interface StoredLedgerTransaction extends NewLedgerTransaction {
  readonly id: string;
  // In id order.
  readonly entries: readonly StoredLedgerEntry[];
}

type Row = Record<string, unknown>;

function actorType(value: unknown): LedgerActorType {
  const text = asText(value);
  const known = LEDGER_ACTOR_TYPES.find((type) => type === text);
  if (known === undefined) throw new TypeError("ledger: unknown actor type");
  return known;
}

function direction(value: unknown): LedgerDirection {
  const text = asText(value);
  const known = LEDGER_DIRECTIONS.find((d) => d === text);
  if (known === undefined) throw new TypeError("ledger: unknown direction");
  return known;
}

function accountType(value: unknown): LedgerAccountType {
  const text = asText(value);
  const known = LEDGER_ACCOUNT_TYPES.find((type) => type === text);
  if (known === undefined) throw new TypeError("ledger: unknown account type");
  return known;
}

function toEntry(row: Row): StoredLedgerEntry {
  return {
    id: asText(row.id),
    accountId: asText(row.account_id),
    accountType: accountType(row.type),
    accountCustomerId: asNullableText(row.customer_id),
    currency: asText(row.currency),
    direction: direction(row.direction),
    amountMinor: toMinor(row.amount_minor),
  };
}

const HEADER_COLUMNS = sql`id, kind, reference_type, reference_id, idempotency_key, actor_type, actor_id, memo`;

async function withEntries(tx: Tx, header: Row): Promise<StoredLedgerTransaction> {
  const id = asText(header.id);
  const result = await tx.execute(
    sql`select e.id, e.account_id, a.type, a.customer_id, a.currency, e.direction, e.amount_minor from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = ${id} order by e.id`,
  );
  return {
    id,
    kind: asText(header.kind),
    referenceType: asText(header.reference_type),
    referenceId: asText(header.reference_id),
    idempotencyKey: asText(header.idempotency_key),
    actorType: actorType(header.actor_type),
    actorId: asNullableText(header.actor_id),
    memo: asNullableText(header.memo),
    entries: (result.rows as Row[]).map(toEntry),
  };
}

export async function findLedgerTransactionByKey(
  tx: Tx,
  idempotencyKey: string,
): Promise<StoredLedgerTransaction | null> {
  const result = await tx.execute(
    sql`select ${HEADER_COLUMNS} from ledger_transactions where idempotency_key = ${idempotencyKey}`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : withEntries(tx, row);
}

export async function findLedgerTransactionById(
  tx: Tx,
  id: string,
): Promise<StoredLedgerTransaction | null> {
  const result = await tx.execute(
    sql`select ${HEADER_COLUMNS} from ledger_transactions where id = ${id}`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : withEntries(tx, row);
}

// The id of a transaction of kind reversal that refers to `originalId`, or null. The index
// ledger_transactions_reference_type_reference_id_idx serves it.
export async function findReversalOf(tx: Tx, originalId: string): Promise<string | null> {
  const result = await tx.execute(
    sql`select id from ledger_transactions where kind = 'reversal' and reference_type = 'ledger_transaction' and reference_id = ${originalId} order by id limit 1`,
  );
  const row = (result.rows as Row[])[0];
  return row === undefined ? null : asText(row.id);
}

// The new id, or null when the key is taken. ON CONFLICT DO NOTHING waits for a concurrent insert
// of the same key to end and then returns no row.
export async function insertLedgerTransaction(
  tx: Tx,
  row: NewLedgerTransaction,
): Promise<string | null> {
  const id = uuidv7();
  const result = await tx.execute(
    sql`insert into ledger_transactions (id, kind, reference_type, reference_id, idempotency_key, actor_type, actor_id, memo) values (${id}, ${row.kind}, ${row.referenceType}, ${row.referenceId}, ${row.idempotencyKey}, ${row.actorType}, ${row.actorId}, ${row.memo}) on conflict (idempotency_key) do nothing returning id`,
  );
  const inserted = (result.rows as Row[])[0];
  return inserted === undefined ? null : asText(inserted.id);
}

// One INSERT for all lines. The ids are uuidv7() values made in this process one after the other,
// which increase even inside one millisecond, so reading the lines `order by e.id` returns them in
// the order they are given here; the order of the lines in the tests depends on it.
export async function insertLedgerEntries(
  tx: Tx,
  transactionId: string,
  entries: readonly NewLedgerEntry[],
): Promise<void> {
  if (entries.length === 0) throw new TypeError("ledger: a transaction needs entries");
  const rows = sql.join(
    entries.map(
      (entry) =>
        sql`(${uuidv7()}, ${transactionId}, ${entry.accountId}, ${entry.direction}, ${entry.amountMinor}::bigint)`,
    ),
    sql`, `,
  );
  await tx.execute(
    sql`insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values ${rows}`,
  );
}
