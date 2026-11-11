import { TENANT_TABLES } from "../tenancy";

// One statement that a repository sent, as a test recorded it: the SQL text, the bound parameters,
// and the customer on whose behalf it ran (null when no customer was acting, for example a seed).
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly actor: string | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A table is named when it stands alone as an identifier, quoted or not: `ssh_keys` and "ssh_keys"
// match, `my_ssh_keys` and `ssh_keys_customer_id_fingerprint_unique` do not. PostgreSQL folds an
// unquoted identifier to lower case, so the match ignores case; it can only find more statements.
const namesTable = (table: string): RegExp =>
  new RegExp(`(^|[^a-z0-9_])"?${escapeRegExp(table)}"?([^a-z0-9_]|$)`, "i");

// R8: every statement that a customer repository sends about a tenant table carries the customer id
// as a bound parameter. This returns the recorded statements that do not: the statements with an
// actor whose SQL names one of `tables` and whose params do not hold the actor as a whole value
// (`"customer:" + actor + ":k"` is not the actor). It reads the statements really sent, so it also
// catches the forms that no lint rule sees, such as a plain string given to tx.execute("...").
export function unscopedStatements(
  statements: readonly RecordedStatement[],
  tables: readonly string[] = Object.keys(TENANT_TABLES),
): RecordedStatement[] {
  const patterns = tables.map(namesTable);
  return statements.filter(
    (s) => s.actor !== null && patterns.some((p) => p.test(s.sql)) && !s.params.includes(s.actor),
  );
}

// A whole UUID (8-4-4-4-12 hex digits, any case) with no hex digit next to it: a longer hex string
// is not one.
const WHOLE_UUID_IN_TEXT =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;

// R8, R11: an id reaches SQL only as a bound parameter. This returns the recorded statements with an
// actor whose SQL text holds a whole UUID: an id written into the text. The lint rule on sql.raw
// cannot see it when it arrives as tx.execute("... '<id>'"), and unscopedStatements does not report
// it when the statement also binds the actor. Judged on the text really sent, whatever the table.
export function statementsWithInlinedIds(
  statements: readonly RecordedStatement[],
): RecordedStatement[] {
  return statements.filter((s) => s.actor !== null && WHOLE_UUID_IN_TEXT.test(s.sql));
}
