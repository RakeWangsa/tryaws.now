import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { beforeAll, expect, it, vi } from "vitest";
import { createDatabase, type Database, type Tx } from "../client";
import { DbError } from "../errors";
import * as schema from "../schema/index";
import {
  attachErrorListeners,
  bindDatabase,
  closeDatabase,
  DATABASE_ROLES,
  getDatabase,
  MAX_TX_ATTEMPTS,
  runTransaction,
  withTx,
  type DatabaseRole,
} from "../tx";
import { useBoundTestDatabase } from "../testing/bind";
import { assertLocalServer } from "./temp-db";

const t = useBoundTestDatabase("web_rw");
beforeAll(async () => {
  await t.pool.query(`create table tx_rows (id uuid primary key);
    create table tx_probe (id int primary key, n int not null); insert into tx_probe values (1, 0), (2, 0);
    create table tx_deferred (id int primary key, d int, constraint tx_deferred_d_key unique (d) deferrable initially deferred)`);
});
const rows = async () =>
  (await t.pool.query("select count(*)::int as n from tx_rows")).rows[0].n as number;
const insert = (tx: Tx) => tx.execute(sql`insert into tx_rows values (gen_random_uuid())`);
const sqlError = (code: string) => Object.assign(new Error("synthetic"), { code });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const poolOf = (db: Database) => (db as unknown as { $client: pg.Pool }).$client;

const ENDED = "withTx: the transaction has ended";

// What a statement on a dead handle fails with. Drizzle wraps whatever the client rejects with in a
// DrizzleQueryError (its message is the query, never the cause), so the refusal is its `cause`.
async function refusal(statement: PromiseLike<unknown>): Promise<string> {
  try {
    await statement;
    return "the statement ran";
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return String((cause instanceof Error ? cause : (error as Error)).message);
  }
}

// A pool of this test's own, on the temporary database. pg-pool waits for every checked-out client
// before pool.end() settles, so a regression that leaks a client must fail the test and not hang it.
async function withOwnPool<T>(
  options: pg.PoolConfig,
  run: (db: Database, pool: pg.Pool) => Promise<T>,
): Promise<T> {
  assertLocalServer(t.url); // a connection of this test's own: the very string it connects with (WP1-T1, ruling S33)
  const { db, pool } = createDatabase(t.url, options);
  attachErrorListeners(pool);
  try {
    return await run(db, pool);
  } finally {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const timeOut = new Promise<void>((resolve) => (giveUp = setTimeout(resolve, 1_000)));
    try {
      await Promise.race([pool.end(), timeOut]);
    } finally {
      clearTimeout(giveUp);
    }
  }
}

// Terminates the backends of the pool with this application_name on this test's database, and no
// other backend: not the helper pool, not the connections of another test file.
const terminateBackendsOf = (applicationName: string) =>
  t.pool.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = $1 and datname = $2 and pid <> pg_backend_pid()`,
    [applicationName, t.name],
  );

const textOf = (config: unknown): string =>
  typeof config === "string" ? config : ((config as { text?: string } | null)?.text ?? "");

// Makes every client of the pool fail `begin` with the error that `make` returns, as a connection
// that died while idle does. The result counts the attempts.
function failBegin(pool: pg.Pool, make: () => Error): { begins: number } {
  const seen = { begins: 0 };
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as unknown as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (config: unknown, ...rest: unknown[]) => {
      if (!textOf(config).startsWith("begin")) return query(config, ...rest);
      seen.begins++;
      return Promise.reject(make());
    };
  });
  return seen;
}

// Runs `run` with withTx on the process-wide database: no binding, DATABASE_URL is the temporary
// database. Closes that pool, restores the environment and the binding of this file afterwards.
async function onTheProcessWideDatabase<T>(run: () => Promise<T>): Promise<T> {
  assertLocalServer(t.url);
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = t.url;
  bindDatabase(null);
  try {
    return await run();
  } finally {
    await closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    bindDatabase({ db: t.db, role: "web_rw" });
  }
}

it("withTx runs on the bound test database and as the bound role (the isolation level is pinned by the test on the database default)", async () => {
  const r = await withTx((tx) =>
    tx.execute(sql`select current_user as u, current_database() as d,
    current_setting('transaction_isolation') as i`),
  );
  expect(r.rows[0]).toEqual({ u: "web_rw", d: t.name, i: "read committed" });
  expect((await t.pool.query("select current_user as u")).rows[0].u).not.toBe("web_rw");
});

it("the bound role is applied: web_rw may not write a table it has no grant on (42501)", async () => {
  await expect(withTx(insert)).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("an error thrown by fn rolls back and reaches the caller as the same object", async () => {
  const before = await rows();
  const boom = new Error("boom");
  await expect(
    runTransaction(t.db, async (tx) => {
      await insert(tx);
      throw boom;
    }),
  ).rejects.toBe(boom);
  expect(await rows()).toBe(before);
});

it("whatever fn returns commits, a failed Result too (F: withTx<T>(fn): Promise<T>)", async () => {
  const before = await rows();
  expect(
    await runTransaction(t.db, async (tx) => {
      await insert(tx);
      return { ok: false, error: "conflict" } as const;
    }),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await rows()).toBe(before + 1);
  expect(
    await runTransaction(t.db, async (tx) => {
      await insert(tx);
      return { ok: true, value: 1 } as const;
    }),
  ).toEqual({ ok: true, value: 1 });
  expect(await rows()).toBe(before + 2);
});

it("fn swallows a database error and returns: withTx fails with DbError 25P02 and nothing is kept", async () => {
  const before = await rows();
  const err = await runTransaction(t.db, async (tx) => {
    await insert(tx);
    try {
      await tx.execute(sql`insert into tx_probe values (1, 5)`); // 23505: the transaction is now failed
    } catch {
      // swallowed on purpose: this is the case under test
    }
    return "done";
  }).catch((e: unknown) => e);
  expect(err).toMatchObject({ name: "DbError", code: "25P02" });
  expect(await rows()).toBe(before);
});

it("a savepoint around a failing statement keeps the transaction healthy", async () => {
  const before = await rows();
  const result = await runTransaction(t.db, async (tx) => {
    await insert(tx);
    await tx
      .transaction((sp) => sp.execute(sql`insert into tx_probe values (1, 5)`))
      .catch(() => undefined);
    return "done";
  });
  expect(result).toBe("done");
  expect(await rows()).toBe(before + 1);
});

it("a connection that breaks inside fn fails the transaction as DbError unknown, is not repeated, and leaves no client behind", async () => {
  await withOwnPool({}, async (db, pool) => {
    let ran = 0;
    const err = await runTransaction(db, async (tx) => {
      ran++;
      const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await t.pool.query("select pg_terminate_backend($1)", [pid]);
      await tx.execute(sql`select 1`);
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "DbError", code: "unknown" });
    expect(ran).toBe(1); // fn had started: the outcome is not known to be harmless, so no repeat
    expect(pool.totalCount).toBe(pool.idleCount);
    expect((await runTransaction(db, (tx) => tx.execute(sql`select 1 as one`))).rows[0]).toEqual({
      one: 1,
    });
  });
});

it("a connection that died while idle does not fail the first transaction, and leaves no client behind", async () => {
  await withOwnPool(
    { max: 1, application_name: "tx_idle_probe", connectionTimeoutMillis: 1_000 },
    async (db, pool) => {
      const one = (tx: Tx) => tx.execute(sql`select 1 as one`);
      expect((await runTransaction(db, one)).rows[0]).toEqual({ one: 1 }); // the only client goes idle
      for (let round = 1; round <= 5; round++) {
        await terminateBackendsOf("tx_idle_probe");
        let ran = 0;
        const result = await runTransaction(db, (tx) => {
          ran++;
          return one(tx);
        });
        expect(result.rows[0], `round ${round}`).toEqual({ one: 1 });
        expect(ran, `round ${round}`).toBe(1); // a begin that failed on the dead client never reached fn
        expect(pool.totalCount, `round ${round}`).toBe(pool.idleCount);
        expect(pool.waitingCount, `round ${round}`).toBe(0);
      }
    },
  );
}, 20_000);

it.each([
  ["unknown", () => new Error("Connection terminated unexpectedly")],
  ["08006", () => sqlError("08006")],
  ["57P01", () => sqlError("57P01")],
  ["57P02", () => sqlError("57P02")],
  ["57P03", () => sqlError("57P03")],
])(
  "a begin that fails with %s is repeated on a fresh client, at most MAX_TX_ATTEMPTS times in all, and fn never ran",
  async (code, make) => {
    await withOwnPool({ max: 5 }, async (db, pool) => {
      const seen = failBegin(pool, make);
      let ran = 0;
      const err = await runTransaction(db, async () => {
        ran++;
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "DbError", code });
      expect(ran).toBe(0);
      expect(seen.begins).toBe(MAX_TX_ATTEMPTS);
      expect(pool.totalCount).toBe(0); // every client whose begin failed was destroyed
    });
  },
);

it("a begin that fails with a code that is no connection failure (53300) is not repeated", async () => {
  await withOwnPool({ max: 5 }, async (db, pool) => {
    const seen = failBegin(pool, () => sqlError("53300"));
    const err = await runTransaction(db, async () => undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "DbError", code: "53300" });
    expect(seen.begins).toBe(1);
    expect(pool.totalCount).toBe(0);
  });
});

it("a database error leaves withTx as a DbError without the parameters", async () => {
  const err = await withTx((tx) => tx.execute(sql`select ${"someone@example.test"}::int`)).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DbError);
  expect(err).toMatchObject({ code: "22P02" });
  expect(JSON.stringify(err) + String(err)).not.toContain("someone@example.test");
});

it("an error at COMMIT (a deferred constraint) is a DbError and nothing is kept", async () => {
  await expect(
    runTransaction(t.db, (tx) => tx.execute(sql`insert into tx_deferred values (1, 7), (2, 7)`)),
  ).rejects.toMatchObject({ name: "DbError", code: "23505", constraint: "tx_deferred_d_key" });
  expect((await t.pool.query("select count(*)::int as n from tx_deferred")).rows[0].n).toBe(0);
});

it.each(["40P01", "40001"])(
  "a failure with %s runs fn again, at most MAX_TX_ATTEMPTS times in all",
  async (code) => {
    expect(MAX_TX_ATTEMPTS).toBe(3);
    let n = 0;
    expect(
      await runTransaction(t.db, async () => {
        n++;
        if (n === 1) throw sqlError(code);
        return 7;
      }),
    ).toBe(7);
    expect(n).toBe(2);
    n = 0;
    await expect(
      runTransaction(t.db, async () => {
        n++;
        throw sqlError(code);
      }),
    ).rejects.toMatchObject({ name: "DbError", code });
    expect(n).toBe(3);
  },
);

it("fn runs exactly once after 23505, after a plain TypeError and after a DbError of another code", async () => {
  let n = 0;
  await expect(
    runTransaction(t.db, async () => {
      n++;
      throw sqlError("23505");
    }),
  ).rejects.toMatchObject({ code: "23505" });
  expect(n).toBe(1);
  n = 0;
  const sentinel = new TypeError("boom");
  await expect(
    runTransaction(t.db, async () => {
      n++;
      throw sentinel;
    }),
  ).rejects.toBe(sentinel);
  expect(n).toBe(1);
  n = 0;
  await expect(
    runTransaction(t.db, async () => {
      n++;
      throw new DbError("22P02");
    }),
  ).rejects.toMatchObject({ name: "DbError", code: "22P02" });
  expect(n).toBe(1);
});

it("a real deadlock: PostgreSQL aborts one transaction, it runs again, and both commit", async () => {
  let attempts = 0;
  let firstLocked!: () => void;
  let secondLocked!: () => void;
  const first = new Promise<void>((r) => (firstLocked = r));
  const second = new Promise<void>((r) => (secondLocked = r));
  const bump = (id: number) => sql`update tx_probe set n = n + 1 where id = ${id}`;
  await Promise.all([
    runTransaction(t.db, async (tx) => {
      attempts++;
      await tx.execute(bump(1));
      firstLocked();
      await second;
      await tx.execute(bump(2));
    }),
    runTransaction(t.db, async (tx) => {
      attempts++;
      await tx.execute(bump(2));
      secondLocked();
      await first;
      await tx.execute(bump(1));
    }),
  ]);
  expect(attempts).toBe(3);
  expect((await t.pool.query("select n from tx_probe order by id")).rows).toEqual([
    { n: 2 },
    { n: 2 },
  ]);
}, 20_000);

it("a nested call is refused (runTransaction and withTx) and the outer transaction rolls back", async () => {
  const before = await rows();
  await expect(
    runTransaction(t.db, async (tx) => {
      await insert(tx);
      return runTransaction(t.db, async () => 1);
    }),
  ).rejects.toThrow("withTx: nested transaction; pass the tx down instead");
  expect(await rows()).toBe(before);
  await expect(withTx(async () => withTx(async () => 1))).rejects.toThrow(
    "withTx: nested transaction; pass the tx down instead",
  );
});

it("a handle that outlived its transaction is refused", async () => {
  const before = await rows();
  let stale!: Tx;
  await runTransaction(t.db, async (tx) => {
    stale = tx;
    await insert(tx);
  });
  expect(await rows()).toBe(before + 1);
  expect(await refusal(insert(stale))).toBe(ENDED);
  expect(await rows()).toBe(before + 1);
});

it("the sibling of a failed Promise.all cannot write after the rollback", async () => {
  const before = await rows();
  let sibling = "the sibling did not run";
  await expect(
    runTransaction(t.db, async (tx) => {
      await Promise.all([
        Promise.reject(new Error("boom")), // not a database error: the transaction itself stays healthy
        (async () => {
          await tx.execute(sql`select pg_sleep(0.2)`); // in flight while fn throws and the rollback queues up behind it
          sibling = await refusal(insert(tx));
        })(),
      ]);
    }),
  ).rejects.toThrow("boom");
  await sleep(400);
  expect(sibling).toBe(ENDED);
  expect(await rows()).toBe(before);
});

it("after a deadlock retry the stray statement of the failed attempt does not commit with the next one", async () => {
  const before = await rows();
  const pids: number[] = [];
  let attempt = 0;
  let failed!: Tx;
  let stray = "the stray statement did not run";
  await runTransaction(t.db, async (tx) => {
    attempt++;
    pids.push(Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid));
    if (attempt === 1) {
      failed = tx;
      throw sqlError("40P01");
    }
    stray = await refusal(insert(failed)); // the handle of attempt 1, now that attempt 2 holds the same client
    await insert(tx);
  });
  expect(attempt).toBe(2);
  expect(pids[1]).toBe(pids[0]); // the same connection: without the guard the stray statement joins attempt 2
  expect(stray).toBe(ENDED);
  expect(await rows()).toBe(before + 1);
});

it("the logger of the Database keeps seeing the statements", async () => {
  const seen: string[] = [];
  const db = drizzle(t.pool, {
    schema,
    logger: {
      logQuery: (query) => {
        seen.push(query);
      },
    },
  });
  await runTransaction(db, (tx) => tx.execute(sql`select 42 as answer`), { role: "web_rw" });
  expect(seen).toEqual([
    "begin isolation level read committed",
    "set local role web_rw",
    "select 42 as answer",
    "select 1",
    "commit",
  ]);
});

it("pool.query and a connect outside a transaction are untouched by the guard", async () => {
  await withOwnPool({ max: 3 }, async (db, pool) => {
    await runTransaction(db, async (tx) => {
      await tx.execute(sql`select 1`);
      // pool.query takes its own client with a callback: it is not the client of the transaction
      expect((await pool.query("select 2 as two")).rows[0]).toEqual({ two: 2 });
    });
    const wrapped = pool.connect;
    await runTransaction(db, (tx) => tx.execute(sql`select 1`));
    expect(pool.connect).toBe(wrapped); // a pool is wrapped once, not once per transaction
    expect((await pool.query("select 3 as three")).rows[0]).toEqual({ three: 3 });
    const client = await pool.connect();
    try {
      expect((await client.query("select 4 as four")).rows[0]).toEqual({ four: 4 });
    } finally {
      client.release();
    }
    expect(pool.totalCount).toBe(pool.idleCount);
  });
});

it("a pool that cannot give a client in time fails the transaction with the time-out of the pool", async () => {
  assertLocalServer(t.url);
  const { db, pool } = createDatabase(t.url, { max: 1, connectionTimeoutMillis: 200 });
  attachErrorListeners(pool);
  const held = await pool.connect();
  try {
    let ran = false;
    const started = Date.now();
    const err = await runTransaction(db, async () => {
      ran = true;
    }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("timeout exceeded when trying to connect");
    expect(ran).toBe(false);
  } finally {
    held.release();
    await pool.end();
  }
});

it("createDatabase gives a pool a connection time-out of 10 seconds unless the caller sets one", async () => {
  assertLocalServer(t.url);
  const fallback = createDatabase(t.url);
  const own = createDatabase(t.url, { connectionTimeoutMillis: 250 });
  try {
    expect(poolOf(fallback.db).options.connectionTimeoutMillis).toBe(10_000);
    expect(poolOf(own.db).options.connectionTimeoutMillis).toBe(250);
  } finally {
    await fallback.pool.end();
    await own.pool.end();
  }
});

it("withTx asks for READ COMMITTED whatever the database default is", async () => {
  await t.pool.query(
    `alter database "${t.name}" set default_transaction_isolation = 'repeatable read'`,
  );
  try {
    await withOwnPool({}, async (db) => {
      const r = await runTransaction(db, (tx) =>
        tx.execute(sql`select current_setting('default_transaction_isolation') as d,
          current_setting('transaction_isolation') as i`),
      );
      expect(r.rows[0]).toEqual({ d: "repeatable read", i: "read committed" });
    });
  } finally {
    await t.pool.query(`alter database "${t.name}" reset default_transaction_isolation`);
  }
});

it("each database role switches to exactly that role", async () => {
  expect([...DATABASE_ROLES]).toEqual(["web_rw", "admin_rw", "worker_rw", "report_ro"]);
  for (const role of ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const) {
    const r = await runTransaction(t.db, (tx) => tx.execute(sql`select current_user as u`), {
      role,
    });
    expect(r.rows[0], role).toEqual({ u: role });
  }
});

it("a role outside the fixed list is refused with a TypeError before any connection is used", async () => {
  await withOwnPool({}, async (db, pool) => {
    for (const role of ["postgres", "constructor"]) {
      let ran = false;
      const err = await runTransaction(
        db,
        async () => {
          ran = true;
        },
        { role: role as DatabaseRole },
      ).catch((e: unknown) => e);
      expect(err, role).toBeInstanceOf(TypeError);
      expect((err as Error).message, role).toBe("withTx: unknown database role");
      expect(ran, role).toBe(false);
      expect(pool.totalCount, role).toBe(0);
    }
  });
});

it("a binding without a role leaves the login role", async () => {
  const owner = decodeURIComponent(new URL(t.url).username);
  bindDatabase({ db: t.db });
  try {
    const r = await withTx((tx) => tx.execute(sql`select current_user as u`));
    expect(r.rows[0]).toEqual({ u: owner });
  } finally {
    bindDatabase({ db: t.db, role: "web_rw" });
  }
});

it("a database that is not backed by a pool is refused with a TypeError", async () => {
  const db = drizzle.mock({ schema }) as unknown as Database;
  const err = await runTransaction(db, async () => 1).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TypeError);
  expect((err as Error).message).toBe("withTx: the database must be backed by a pg.Pool");
});

it("without a binding withTx uses the process-wide database from DATABASE_URL and sets no role", async () => {
  const owner = decodeURIComponent(new URL(t.url).username);
  const r = await onTheProcessWideDatabase(() =>
    withTx((tx) => tx.execute(sql`select current_user as u, current_database() as d`)),
  );
  expect(r.rows[0]).toEqual({ u: owner, d: t.name });
});

it("the process-wide pool carries the error listeners", async () => {
  await onTheProcessWideDatabase(async () => {
    const pool = poolOf(getDatabase());
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(pool.listenerCount("connect")).toBeGreaterThan(0);
  });
});

it("the error listeners swallow every error, again and again, and write nothing (R14)", () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  try {
    const pool = new EventEmitter() as unknown as pg.Pool;
    attachErrorListeners(pool);
    const client = new EventEmitter();
    pool.emit("connect", client);
    const boom = new Error("value someone@example.test");
    expect(() => pool.emit("error", boom, client)).not.toThrow();
    expect(() => client.emit("error", boom)).not.toThrow();
    expect(() => client.emit("error", boom)).not.toThrow(); // added with on, not once
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

it("a backend that dies while its client is idle does not end the process, and the next transaction works", async () => {
  await withOwnPool({ application_name: "tx_idle_listener" }, async (db) => {
    const one = (tx: Tx) => tx.execute(sql`select 1 as one`);
    await runTransaction(db, one);
    await terminateBackendsOf("tx_idle_listener");
    await sleep(300); // long enough for the pool to see the close; an unhandled 'error' would fail the run
    expect((await runTransaction(db, one)).rows[0]).toEqual({ one: 1 });
  });
});

it("getDatabase creates one database per process until closeDatabase", async () => {
  const a = getDatabase();
  expect(getDatabase()).toBe(a);
  await closeDatabase();
  const b = getDatabase();
  expect(b).not.toBe(a);
  await closeDatabase();
});

it("closeDatabase forgets the pool at once, ends it, and may be called again", async () => {
  await onTheProcessWideDatabase(async () => {
    const first = getDatabase();
    const pool = poolOf(first);
    await withTx((tx) => tx.execute(sql`select 1`)); // the pool now holds a client
    const closing = closeDatabase();
    expect(getDatabase()).not.toBe(first); // forgotten before the end is awaited
    await closing;
    expect(pool.ended).toBe(true);
    await closeDatabase(); // ends the pool of the getDatabase above
    await expect(closeDatabase()).resolves.toBeUndefined();
  });
});
