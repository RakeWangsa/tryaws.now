import { TENANT_TABLES } from "../tenancy";
import type { Queryable } from "../test/sql";

// Every row that one customer owns, in every tenant table, so that a test can compare the rows
// before and after an action by someone else. A row is its jsonb text, which keeps a bigint exact;
// the rows of a table are in id order and the tables are in name order.
//
// It runs as the owner of the database and sees every row: give it the owner's pool, never a
// connection that took a role (web_rw cannot read every column, and to_jsonb(t) reads them all).
// The table names and predicates come from TENANT_TABLES only, never from input (R11); the customer
// id is the one bound parameter.
export async function tenantSnapshot(
  q: Queryable,
  customerId: string,
): Promise<Record<string, string[]>> {
  const snapshot: Record<string, string[]> = {};
  const tables = Object.entries(TENANT_TABLES).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [table, predicate] of tables) {
    const { rows } = await q.query<{ row: string }>(
      `select to_jsonb(t)::text as row from ${table} t where ${predicate} order by t.id`,
      [customerId],
    );
    snapshot[table] = rows.map((r) => r.row);
  }
  return snapshot;
}
