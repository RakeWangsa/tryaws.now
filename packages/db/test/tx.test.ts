import { sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { createDatabase, type Tx } from "../client";
import { DbError } from "../errors";
import {
  attachErrorListeners,
  closeDatabase,
  getDatabase,
  MAX_TX_ATTEMPTS,
  runTransaction,
  withTx,
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

it("withTx runs on the bound test database, as the bound role, in READ COMMITTED", async () => {
  const r = await withTx((tx) =>
    tx.execute(sql`select current_user as u, current_database() as d,
    current_setting('transaction_isolation') as i`),
  );
  expect(r.rows[0]).toEqual({ u: "web_rw", d: t.name, i: "read committed" });
  expect((await t.pool.query("select current_user as u")).rows[0].u).not.toBe("web_rw");
});

it("the grants of migration 0006 apply: web_rw may not write a table it has no grant on", async () => {
  await expect(withTx(insert)).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("an error thrown by fn rolls back and reaches the caller unchanged", async () => {
  const before = await rows();
  await expect(
    runTransaction(t.db, async (tx) => {
      await insert(tx);
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
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

it("a connection that breaks inside a transaction fails it as DbError unknown, and the pool recovers", async () => {
  assertLocalServer(t.url); // a connection of this test's own: the very string it connects with (WP1-T1, ruling S33)
  const { db, pool } = createDatabase(t.url);
  attachErrorListeners(pool);
  try {
    const err = await runTransaction(db, async (tx) => {
      const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await t.pool.query("select pg_terminate_backend($1)", [pid]);
      await tx.execute(sql`select 1`);
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "DbError", code: "unknown" });
    expect((await runTransaction(db, (tx) => tx.execute(sql`select 1 as one`))).rows[0]).toEqual({
      one: 1,
    });
  } finally {
    await pool.end();
  }
});

it("a database error leaves withTx as a DbError without the parameters", async () => {
  const err = await runTransaction(t.db, (tx) =>
    tx.execute(sql`select ${"someone@example.test"}::int`),
  ).catch((e: unknown) => e);
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

it("retries a deadlock or a serialization failure, at most MAX_TX_ATTEMPTS times, and nothing else", async () => {
  expect(MAX_TX_ATTEMPTS).toBe(3);
  let n = 0;
  expect(
    await runTransaction(t.db, async () => {
      n++;
      if (n === 1) throw sqlError("40P01");
      return 7;
    }),
  ).toBe(7);
  expect(n).toBe(2);
  n = 0;
  await expect(
    runTransaction(t.db, async () => {
      n++;
      throw sqlError("40001");
    }),
  ).rejects.toMatchObject({ code: "40001" });
  expect(n).toBe(3);
  n = 0;
  await expect(
    runTransaction(t.db, async () => {
      n++;
      throw sqlError("23505");
    }),
  ).rejects.toMatchObject({ code: "23505" });
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

it("a nested withTx is refused and the outer transaction rolls back", async () => {
  const before = await rows();
  await expect(
    runTransaction(t.db, async (tx) => {
      await insert(tx);
      return runTransaction(t.db, async () => 1);
    }),
  ).rejects.toThrow("withTx: nested transaction; pass the tx down instead");
  expect(await rows()).toBe(before);
});

it("getDatabase creates one database per process until closeDatabase", async () => {
  const a = getDatabase();
  expect(getDatabase()).toBe(a);
  await closeDatabase();
  const b = getDatabase();
  expect(b).not.toBe(a);
  await closeDatabase();
});
