import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createDatabase, type Database, type Tx } from "./client";
import { databaseUrl } from "./env";
import { isRetryable, toDbError, type DbError } from "./errors";

// The database roles that the application may switch to with `set local role` (migration 0006).
// DatabaseRole, ROLE_SQL and the role list of the test helpers all derive from this list.
export const DATABASE_ROLES = ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

export const MAX_TX_ATTEMPTS = 3;

// The role reaches SQL only through this fixed map, never from input.
const ROLE_SQL: Record<DatabaseRole, string> = {
  web_rw: "web_rw",
  admin_rw: "admin_rw",
  worker_rw: "worker_rw",
  report_ro: "report_ro",
};

// A connection that breaks emits `error` on its client: on an idle pooled client (the server or RDS
// Proxy closed it, a failover, a Lambda that was frozen) pg-pool re-emits it on the pool, and on a
// client that a transaction holds it stays on the client. Without a listener Node throws it and the
// process exits. pg-pool puts the client, with its connection parameters and the password, on the
// error it emits, so the listeners do nothing and never log the error (R14). A transaction on a
// broken client then fails at its next statement, and the pool drops the broken client on release.
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

const ENDED = "withTx: the transaction has ended";

// A client that one attempt took out of the pool, behind a guard (see guard()).
interface Checkout {
  readonly client: pg.PoolClient;
  // Closes the guard. A client that drizzle did not release (its `begin` failed) is destroyed.
  finish(): void;
}

// What one pass of the retry loop of runTransaction took out of the pool.
interface Attempt {
  readonly checkouts: Checkout[];
}

const active = new AsyncLocalStorage<Attempt>();

// The statements of fn, and those of every promise or timer that fn starts, run in the scope of fn
// (AsyncLocalStorage follows them). It is settled as soon as fn has returned or thrown. Drizzle's
// own `commit` and `rollback`, and the probe below, are issued outside this scope.
interface FnScope {
  settled: boolean;
}

const insideFn = new AsyncLocalStorage<FnScope>();

async function inScopeOfFn<T>(run: () => Promise<T>): Promise<T> {
  const scope: FnScope = { settled: false };
  try {
    return await insideFn.run(scope, run);
  } finally {
    scope.settled = true;
  }
}

// The client that drizzle gets instead of the pool client. It forwards everything to the real
// client, except `query` and `release`:
// - `query` is refused once the transaction is over, so a late statement (the sibling of a failed
//   Promise.all, a timer, a handle that the caller kept) cannot reach a client that has been given
//   to the next transaction or that autocommits. The transaction is over for a statement of fn when
//   fn has settled, not only when the client is released: a sibling that resumes while the
//   `rollback` of drizzle is already queued would otherwise queue its statement behind the
//   rollback, and PostgreSQL would run it on its own, committed;
// - `release` runs once, and tells `query` that the transaction is over. Drizzle calls it in a
//   `finally`, but not when its `begin` fails, which is why `finish` exists.
// The prototype stays that of the real client, so drizzle does not take it for a pool.
function guard(real: pg.PoolClient): Checkout {
  let open = true;
  let released = false;
  const release = (destroy?: Error | boolean): void => {
    open = false;
    if (released) return;
    released = true;
    real.release(destroy);
  };
  const query = (...args: unknown[]): unknown =>
    open && !insideFn.getStore()?.settled
      ? (Reflect.apply(real.query, real, args) as unknown)
      : Promise.reject(new Error(ENDED));
  const client = new Proxy(real, {
    get(target, property) {
      if (property === "query") return query;
      if (property === "release") return release;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { client, finish: () => release(released ? undefined : true) };
}

const guarded = new WeakSet<pg.Pool>();

// Once per pool: a pool.connect() without arguments inside an attempt returns a guarded client and
// notes it in the attempt. A call with a callback (what pool.query uses) and a call outside an
// attempt are the real connect, unchanged.
function guardCheckouts(pool: pg.Pool): void {
  if (guarded.has(pool)) return;
  guarded.add(pool);
  const connect = pool.connect.bind(pool) as unknown as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: typeof connect }).connect = (...args) => {
    const attempt = active.getStore();
    if (args.length > 0 || attempt === undefined) return connect(...args);
    return (connect() as Promise<pg.PoolClient>).then((real) => {
      const checkout = guard(real);
      attempt.checkouts.push(checkout);
      return checkout.client;
    });
  };
}

function poolOf(db: Database): pg.Pool {
  const client: unknown = (db as unknown as { $client?: unknown }).$client;
  if (!(client instanceof pg.Pool)) {
    throw new TypeError("withTx: the database must be backed by a pg.Pool");
  }
  return client;
}

// The server or the network dropped the connection: class 08, 57P01 to 57P03, or an error without
// a SQLSTATE, which is what the driver reports for a socket that closed.
const SHUTDOWN_SQLSTATES: readonly string[] = ["57P01", "57P02", "57P03"];
const isConnectionFailure = (error: DbError): boolean =>
  error.code === "unknown" ||
  error.code.startsWith("08") ||
  SHUTDOWN_SQLSTATES.includes(error.code);

export async function runTransaction<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
  options: { role?: DatabaseRole } = {},
): Promise<T> {
  if (active.getStore()) throw new Error("withTx: nested transaction; pass the tx down instead");
  const { role } = options;
  if (role !== undefined && !DATABASE_ROLES.includes(role)) {
    throw new TypeError("withTx: unknown database role");
  }
  guardCheckouts(poolOf(db));
  for (let attempt = 1; ; attempt++) {
    const used: Attempt = { checkouts: [] };
    let started = false; // fn has been called
    try {
      return await active.run(used, () =>
        db.transaction(
          async (tx) => {
            if (role !== undefined) await tx.execute(sql.raw(`set local role ${ROLE_SQL[role]}`));
            started = true;
            // Whatever fn returns commits, a failed Result too (F).
            const result = await inScopeOfFn(() => fn(tx));
            // After a database error that fn swallowed PostgreSQL answers COMMIT with ROLLBACK and
            // no error. In a failed transaction this statement fails with 25P02, and drizzle rolls
            // back; in a healthy one (also after a savepoint that fn rolled back to) it costs a
            // round trip.
            await tx.execute(sql`select 1`);
            return result;
          },
          { isolationLevel: "read committed" },
        ),
      );
    } catch (error) {
      const dbError = toDbError(error);
      // A deadlock or a serialization failure, and a connection that failed before fn was called
      // (nothing ran, and the pool gives the repeat a fresh client).
      if (
        dbError &&
        attempt < MAX_TX_ATTEMPTS &&
        (isRetryable(dbError) || (!started && isConnectionFailure(dbError)))
      ) {
        continue;
      }
      throw dbError ?? error;
    } finally {
      for (const checkout of used.checkouts) checkout.finish();
    }
  }
}

/**
 * Runs `fn` in one READ COMMITTED transaction on the process-wide database.
 *
 * - Whatever `fn` returns commits, a failed `Result` too. An action that must leave nothing
 *   behind throws inside `fn`; the error rolls back and reaches the caller (a database error as
 *   `DbError`, anything else unchanged).
 * - A database error that `fn` catches and swallows does not commit: PostgreSQL marks the whole
 *   transaction as failed, and withTx then fails with `DbError` 25P02 instead of reporting a
 *   success for work that was rolled back. To handle a failing statement inside `fn`, run it in a
 *   savepoint, `tx.transaction(...)`, which leaves the transaction healthy.
 * - `fn` runs again after a deadlock or a serialization failure (40P01, 40001) and after a
 *   connection failure that happened before `fn` was called, at most MAX_TX_ATTEMPTS times in all.
 *   So `fn` must have no effect outside the database (send a queue message after the commit, not
 *   inside `fn`).
 * - Use `tx` only until `fn` has returned, and await every statement. A statement on `tx` after
 *   that (a promise `fn` left running, a timer, a handle the caller kept) is refused: it fails
 *   with an error whose cause is `Error("withTx: the transaction has ended")`.
 * - A database error that happens while a statement runs leaves as a `DbError` (SQLSTATE and the
 *   names of the constraint or table, never the message or the values). Errors that are not
 *   database errors, and failures to get a connection at all, leave unchanged.
 * - `DbError` with code `unknown` means the connection broke. If it broke while `COMMIT` was in
 *   flight, the outcome of the transaction is not known: retry only with the idempotency key. When
 *   the connection breaks and `rollback` fails too, the error of the rollback replaces the
 *   original error. The pool drops a broken client.
 * - A nested call is refused: pass the `tx` down instead.
 */
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransaction(binding?.db ?? getDatabase(), fn, { role: binding?.role });
}
