import type pg from "pg";
import { beforeAll, expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { asRole, columnsOf, expectSqlError, inTransaction, insertRow, type AppRole } from "./sql";
import { columnTests, EXPECTED_COLUMNS, expectedFor } from "./expected-columns";

const t = useTempDatabase({ migrate: false });
const readTooEarly = (() => {
  try {
    return String(t.pool);
  } catch (e) {
    return (e as Error).message;
  }
})();
beforeAll(async () => {
  await t.pool.query(`create table harness_t (
    id uuid primary key, created_at timestamptz not null default now(), a int4 not null, b numeric(12,4), c text[], j jsonb,
    d int4 unique deferrable initially deferred,
    constraint harness_t_a_check check (a > 0))`);
});

const count = async () =>
  (await t.pool.query("select count(*)::int as n from harness_t")).rows[0].n as number;

it("useTempDatabase gives one database per file and refuses a read before its beforeAll", async () => {
  expect(readTooEarly).toBe(
    "useTempDatabase: the database is not ready; read it inside a hook or a test",
  );
  expect(t.name).toMatch(/^tc_test_\d+_[0-9a-f]{8}$/);
  expect((await t.pool.query("select current_database() as db")).rows[0].db).toBe(t.name);
});

it("columnsOf gives name, udt type and nullability, sorted", async () => {
  expect(await columnsOf(t.pool, "harness_t")).toEqual([
    "a int4 NOT NULL",
    "b numeric(12,4) NULL",
    "c _text NULL",
    "created_at timestamptz NOT NULL",
    "d int4 NULL",
    "id uuid NOT NULL",
    "j jsonb NULL",
  ]);
});

EXPECTED_COLUMNS.harness_t = [
  "a int4 NOT NULL",
  "b numeric(12,4) NULL",
  "c _text NULL",
  "d int4 NULL",
  "j jsonb NULL",
];
columnTests(() => t.pool, ["harness_t"]);

it("expectedFor adds id and created_at, and refuses an unknown table", () => {
  expect(expectedFor("harness_t")).toHaveLength(7);
  expect(() => expectedFor("nope")).toThrow("no expected columns for nope");
});

it("insertRow adds a v7 id and passes a jsonb array as JSON text", async () => {
  const id = await insertRow(t.pool, "harness_t", { a: 1, j: "[]", c: ["x"] });
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  const { rows } = await t.pool.query("select j, c from harness_t where id = $1", [id]);
  expect(rows[0]).toEqual({ j: [], c: ["x"] });
});

it("expectSqlError matches code and constraint, also when Drizzle wraps the error in cause", async () => {
  await expectSqlError(insertRow(t.pool, "harness_t", { a: 0 }), "23514", {
    constraint: "harness_t_a_check",
  });
  const wrapped = Object.assign(new Error("Failed query"), {
    cause: { code: "23514", constraint: "harness_t_a_check", message: "x" },
  });
  await expectSqlError(Promise.reject(wrapped), "23514", { constraint: "harness_t_a_check" });
  await expect(expectSqlError(insertRow(t.pool, "harness_t", { a: 0 }), "23505")).rejects.toThrow();
  await expect(expectSqlError(Promise.resolve(1), "23514")).rejects.toThrow();
});

it("expectSqlError rejects a wrong constraint, a wrong message and a wrong outer code", async () => {
  await expect(
    expectSqlError(insertRow(t.pool, "harness_t", { a: 0 }), "23514", {
      constraint: "other_check",
    }),
  ).rejects.toThrow();
  await expect(
    expectSqlError(insertRow(t.pool, "harness_t", { a: 0 }), "23514", { message: /no such text/ }),
  ).rejects.toThrow();
  await expectSqlError(insertRow(t.pool, "harness_t", { a: 0 }), "23514", {
    message: /harness_t_a_check/,
  });
  const outer = Object.assign(new Error("x"), { code: "23505", cause: { code: "23514" } });
  await expect(expectSqlError(Promise.reject(outer), "23514")).rejects.toThrow();
});

it("asRole refuses an unknown role by name, before it takes a client", async () => {
  await expect(asRole(t.pool, "postgres" as AppRole, async () => 1)).rejects.toThrow(/postgres/);
});

it("columnsOf gives plain numeric for a numeric column without precision", async () => {
  await t.pool.query("create table harness_n (id uuid primary key, n numeric)");
  expect(await columnsOf(t.pool, "harness_n")).toEqual(["id uuid NOT NULL", "n numeric NULL"]);
});

function fakePool(rollbackFails: boolean) {
  const releases: unknown[][] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("rollback failed");
      return { rows: [] };
    },
    release: (...args: unknown[]) => {
      releases.push(args);
    },
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, releases };
}

it.each([
  [
    "inTransaction",
    (p: pg.Pool) => inTransaction(p, async () => Promise.reject(new Error("boom"))),
  ],
  ["asRole", (p: pg.Pool) => asRole(p, "web_rw", async () => Promise.reject(new Error("boom")))],
])(
  "%s destroys the client when ROLLBACK fails and rethrows the original error",
  async (_n, run) => {
    const { pool, releases } = fakePool(true);
    await expect(run(pool)).rejects.toThrow("boom");
    expect(releases).toEqual([[true]]);
  },
);

it.each([
  [
    "inTransaction",
    (p: pg.Pool) => inTransaction(p, async () => Promise.reject(new Error("boom"))),
  ],
  ["asRole", (p: pg.Pool) => asRole(p, "web_rw", async () => Promise.reject(new Error("boom")))],
])("%s keeps the client when ROLLBACK works", async (_n, run) => {
  const { pool, releases } = fakePool(false);
  await expect(run(pool)).rejects.toThrow("boom");
  expect(releases).toHaveLength(1);
  expect(releases[0]![0]).toBeFalsy();
});

it("asRole gives the caller the ROLLBACK error when fn succeeded", async () => {
  const { pool, releases } = fakePool(true);
  await expect(asRole(pool, "web_rw", async () => 1)).rejects.toThrow("rollback failed");
  expect(releases).toEqual([[true]]);
});

it("inTransaction rolls back when fn throws and when COMMIT fails", async () => {
  const before = await count();
  await expect(
    inTransaction(t.pool, async (c) => {
      await c.query("insert into harness_t (id, a) values (gen_random_uuid(), 5)");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await count()).toBe(before);
  await expectSqlError(
    inTransaction(t.pool, async (c) => {
      await c.query(
        "insert into harness_t (id, a, d) values (gen_random_uuid(), 5, 7), (gen_random_uuid(), 6, 7)",
      );
    }),
    "23505",
  );
  expect(await count()).toBe(before);
});
