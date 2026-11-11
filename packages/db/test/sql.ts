import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { DATABASE_ROLES, type DatabaseRole } from "../tx";

export type Queryable = pg.Pool | pg.PoolClient;
export type AppRole = DatabaseRole;

const ROLES: readonly AppRole[] = DATABASE_ROLES;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`not a plain SQL identifier: ${name}`);
  return `"${name}"`;
}

// information_schema.columns shows only the columns the current role may see: call it as the owner.
export async function columnsOf(q: Queryable, table: string): Promise<string[]> {
  const { rows } = await q.query<{
    column_name: string;
    udt_name: string;
    is_nullable: string;
    numeric_precision: number | null;
    numeric_scale: number | null;
  }>(
    `select column_name, udt_name, is_nullable, numeric_precision, numeric_scale
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return rows
    .map((r) => {
      const type =
        r.udt_name === "numeric" && r.numeric_precision !== null
          ? `numeric(${r.numeric_precision},${r.numeric_scale})`
          : r.udt_name;
      return `${r.column_name} ${type} ${r.is_nullable === "NO" ? "NOT NULL" : "NULL"}`;
    })
    .sort();
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

export async function expectSqlError(
  p: Promise<unknown>,
  code: string,
  detail: { constraint?: string; message?: RegExp } = {},
): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`expected a PostgreSQL error ${code}, but the promise resolved`);
  }
  const outer = caught as PgErrorLike & { cause?: PgErrorLike };
  const pgErr: PgErrorLike = outer.code !== undefined ? outer : (outer.cause ?? outer);
  if (pgErr.code !== code) {
    throw new Error(`expected PostgreSQL error ${code}, got ${pgErr.code}: ${pgErr.message}`);
  }
  if (detail.constraint !== undefined && pgErr.constraint !== detail.constraint) {
    throw new Error(`expected constraint ${detail.constraint}, got ${pgErr.constraint}`);
  }
  if (detail.message !== undefined && !detail.message.test(pgErr.message ?? "")) {
    throw new Error(`message ${JSON.stringify(pgErr.message)} does not match ${detail.message}`);
  }
}

export async function insertRow(
  q: Queryable,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const row: Record<string, unknown> = { ...values, id: values.id ?? uuidv7() };
  const keys = Object.keys(row);
  const cols = keys.map(identifier).join(", ");
  const params = keys.map((_, i) => `$${i + 1}`).join(", ");
  await q.query(
    `insert into ${identifier(table)} (${cols}) values (${params})`,
    keys.map((k) => row[k]),
  );
  return row.id as string;
}

// Runs ROLLBACK and releases the client. A client whose ROLLBACK fails may still sit inside the
// transaction (and keep SET LOCAL ROLE), so it is released as broken and the pool destroys it.
// Returns the ROLLBACK error, if any; the caller decides which error to throw.
async function rollbackAndRelease(c: pg.PoolClient): Promise<unknown> {
  let failure: { error: unknown } | undefined;
  try {
    await c.query("ROLLBACK");
  } catch (error) {
    failure = { error };
  }
  c.release(failure !== undefined);
  return failure;
}

export async function inTransaction<T>(
  pool: pg.Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    c.release();
    return result;
  } catch (err) {
    await rollbackAndRelease(c); // the original error wins over a failed ROLLBACK
    throw err;
  }
}

export async function asRole<T>(
  pool: pg.Pool,
  role: AppRole,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const c = await pool.connect();
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    result = await fn(c);
  } catch (error) {
    failure = { error };
  }
  const rollback = (await rollbackAndRelease(c)) as { error: unknown } | undefined;
  if (failure) throw failure.error;
  if (rollback) throw rollback.error;
  return result as T;
}
