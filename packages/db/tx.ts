import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { createDatabase, type Database, type Tx } from "./client";
import { databaseUrl } from "./env";
import { isRetryable, toDbError } from "./errors";

// The one source of the database role names (migration 0006).
export type DatabaseRole = "web_rw" | "admin_rw" | "worker_rw" | "report_ro";

export const MAX_TX_ATTEMPTS = 3;

// The role reaches SQL only through this fixed map, never from input.
const ROLE_SQL: Record<DatabaseRole, string> = {
  web_rw: "web_rw",
  admin_rw: "admin_rw",
  worker_rw: "worker_rw",
  report_ro: "report_ro",
};

// A connection that breaks while a transaction holds its client emits `error` on that client;
// without a listener Node throws it and the process exits. The listeners do nothing and never log
// the error, because it can echo values (R14). The broken transaction then fails at its next
// statement, and the pool drops the broken client on release.
export function attachErrorListeners(pool: pg.Pool): void {
  pool.on("error", () => {});
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
}

let current: { db: Database; pool: pg.Pool } | undefined;

// One database, and one pool, for the life of the process (one pool per Lambda instance).
export function getDatabase(): Database {
  if (!current) {
    const { db, pool } = createDatabase(databaseUrl());
    attachErrorListeners(pool);
    current = { db, pool };
  }
  return current.db;
}

// Ends the pool of getDatabase and forgets it; the next getDatabase creates a new one.
export async function closeDatabase(): Promise<void> {
  const closing = current;
  current = undefined;
  if (closing) await closing.pool.end();
}

export interface DatabaseBinding {
  readonly db: Database;
  readonly role?: DatabaseRole;
}

let binding: DatabaseBinding | null = null;

// Tests only: while a binding is set, withTx uses it instead of getDatabase().
export function bindDatabase(next: DatabaseBinding | null): void {
  binding = next;
}

const active = new AsyncLocalStorage<true>();

export async function runTransaction<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
  options: { role?: DatabaseRole } = {},
): Promise<T> {
  if (active.getStore()) throw new Error("withTx: nested transaction; pass the tx down instead");
  for (let attempt = 1; ; attempt++) {
    try {
      return await active.run(true, () =>
        db.transaction(
          async (tx) => {
            if (options.role) await tx.execute(sql.raw(`set local role ${ROLE_SQL[options.role]}`));
            // Whatever fn returns commits, a failed Result too (F).
            return fn(tx);
          },
          { isolationLevel: "read committed" },
        ),
      );
    } catch (error) {
      const dbError = toDbError(error);
      if (dbError && isRetryable(dbError) && attempt < MAX_TX_ATTEMPTS) continue;
      throw dbError ?? error;
    }
  }
}

/**
 * Runs `fn` in one READ COMMITTED transaction on the process-wide database.
 *
 * - On a deadlock or a serialization failure the transaction rolls back and `fn` runs again from
 *   the start on a new transaction, at most MAX_TX_ATTEMPTS times in all. So `fn` must have no
 *   effect outside the database (send a queue message after the commit, not inside `fn`).
 * - Whatever `fn` returns commits, a failed `Result` too. An action that must leave nothing
 *   behind throws inside `fn`; the error rolls back and reaches the caller unchanged.
 * - Every database error leaves as a `DbError` (SQLSTATE and constraint or table name only).
 * - When the connection breaks and `rollback` fails too, the original error is lost and the
 *   caller gets `DbError` with code `unknown`.
 * - A nested call is refused: pass the `tx` down instead.
 */
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransaction(binding?.db ?? getDatabase(), fn, { role: binding?.role });
}
