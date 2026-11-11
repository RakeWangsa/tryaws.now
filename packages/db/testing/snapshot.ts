import { TENANT_TABLES } from "../tenancy";
import type { Queryable } from "../test/sql";

// The table names go into the SQL text, so they must be plain identifiers.
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

// Every row that one customer owns, in every tenant table, so that a test can compare the rows
// before and after an action by someone else. A row is its jsonb text, which keeps a bigint exact;
// the rows of a table are in id order and the tables are in name order.
//
// It runs as the owner of the database and sees every row: give it the owner's pool, never a
// connection that took a role (web_rw cannot read every column, and to_jsonb(t) reads them all).
// The table names and predicates come from TENANT_TABLES only, never from input (R11); the customer
// id is the one bound parameter.
//
// It fails closed (R16): a snapshot of nothing would let every before/after check pass. An id that is
// not a string is a TypeError before any query; a string that is no UUID is refused by the database
// cast (22P02); an id that is no customer is an error after the queries, whose message holds no data.
export async function tenantSnapshot(
  q: Queryable,
  customerId: string,
): Promise<Record<string, string[]>> {
  if (typeof customerId !== "string") {
    throw new TypeError("tenantSnapshot: the customer id must be a string");
  }
  const tables = Object.entries(TENANT_TABLES).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [table] of tables) {
    if (!PLAIN_NAME.test(table)) {
      throw new Error(`tenantSnapshot: not a plain table name: ${JSON.stringify(table)}`);
    }
  }
  const snapshot: Record<string, string[]> = {};
  for (const [table, predicate] of tables) {
    // The predicate may hold `or`: the parentheses keep it one condition.
    const { rows } = await q.query<{ row: string }>(
      `select to_jsonb(t)::text as row from ${table} t where (${predicate}) order by t.id`,
      [customerId],
    );
    snapshot[table] = rows.map((r) => r.row);
  }
  if (snapshot.customers?.length !== 1) throw new Error("tenantSnapshot: no such customer");
  return snapshot;
}
