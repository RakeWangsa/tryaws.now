import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import {
  checkTenantIsolation,
  expectTenantIsolation,
  ghostOf,
  type TenantCase,
} from "../testing/cross-tenant";
import { statementsWithInlinedIds, unscopedStatements } from "../testing/sql-audit";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

const t = useTempDatabase();
type S = { keyId: string; resourceId: string };
const seed = async (pool: typeof t.pool, c: string): Promise<S> => ({
  keyId: await insertRow(pool, "ssh_keys", {
    customer_id: c,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:" + uniqueSuffix(),
  }),
  resourceId: await newResource(pool, c),
});
const q = (text: string, values: unknown[]) => t.pool.query(text, values);
const check = (c: TenantCase<S>) => checkTenantIsolation({ pool: t.pool, seed, cases: [c] });

const scopedGet: TenantCase<S> = {
  name: "scopedGet",
  kind: "read",
  run: async (c, s) =>
    (await q("select id, name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
      .rows[0] ?? null,
};
const scopedDelete: TenantCase<S> = {
  name: "scopedDelete",
  kind: "write",
  run: async (c, s) =>
    (await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c])).rowCount
      ? "deleted"
      : "not_found",
};
const scopedChild: TenantCase<S> = {
  name: "scopedChild",
  kind: "write",
  run: async (c, s) =>
    (
      await q(
        `insert into operations (id, resource_id, kind, idempotency_key)
    select $1, r.id, 'reboot', $2 from resources r where r.id = $3 and r.customer_id = $4`,
        [uuidv7(), uniqueSuffix(), s.resourceId, c],
      )
    ).rowCount
      ? "created"
      : "not_found",
};
const scopedAdd: TenantCase<S> = {
  name: "scopedAdd",
  kind: "self-write",
  run: async (c) => {
    await q(
      "insert into ssh_keys (id, customer_id, name, public_key, fingerprint) values ($1, $2, 'x', 'ssh-ed25519 B', $3)",
      [uuidv7(), c, "SHA256:" + uniqueSuffix()],
    );
    return "created";
  },
};

it("scoped reads, writes, child inserts and self-writes pass", async () => {
  await expectTenantIsolation({
    pool: t.pool,
    seed,
    cases: [scopedGet, scopedDelete, scopedChild, scopedAdd],
  });
});

it.each<[string, TenantCase<S>, string, string, string[]]>([
  [
    "a read that lost its scope",
    {
      name: "leakyGet",
      kind: "read",
      run: async (_c, s) =>
        (await q("select id, name from ssh_keys where id = $1", [s.keyId])).rows[0] ?? null,
    },
    "cross-read",
    "names a row of customer A",
    ["cross-read"],
  ],
  [
    "a read that tells existence apart",
    {
      name: "existence",
      kind: "read",
      run: async (c, s) => {
        const any = (await q("select customer_id from ssh_keys where id = $1", [s.keyId])).rows[0];
        return any === undefined ? "not_found" : any.customer_id === c ? "mine" : "forbidden";
      },
    },
    "cross-read",
    "another answer for a row of customer A than for a missing row",
    ["cross-read"],
  ],
  [
    "a read that finds nothing at all",
    { name: "blind", kind: "read", run: async () => null },
    "own-read",
    "the case proves nothing",
    ["own-read"],
  ],
  [
    "a delete that lost its scope",
    {
      name: "leakyDelete",
      kind: "write",
      run: async (_c, s) =>
        (await q("delete from ssh_keys where id = $1", [s.keyId])).rowCount
          ? "deleted"
          : "not_found",
    },
    "cross-write",
    "changed rows of customer A in: ssh_keys",
    // Its effect, its answer ("deleted" against "not_found"), and A has no row left to delete.
    ["cross-write", "cross-write", "own-write"],
  ],
  [
    "a child insert that does not check the parent's owner",
    {
      name: "leakyChild",
      kind: "write",
      run: async (_c, s) => {
        await q(
          "insert into operations (id, resource_id, kind, idempotency_key) values ($1, $2, 'reboot', $3)",
          [uuidv7(), s.resourceId, uniqueSuffix()],
        );
        return "created";
      },
    },
    "cross-write",
    "changed rows of customer A in: operations",
    // Its effect, and its answer ("created" against the foreign key error of the missing resource).
    ["cross-write", "cross-write"],
  ],
  [
    "a write that changes nothing",
    { name: "noop", kind: "write", run: async () => "ok" },
    "own-write",
    "the case proves nothing",
    ["own-write"],
  ],
  // The next two rows pin the two checks of the write branch that no row above depends on. Both
  // writes leave the rows of customer A alone: one answers B differently than for a missing row,
  // the other names a row of customer A in its answer.
  [
    "a write that tells existence apart",
    {
      name: "existenceWrite",
      kind: "write",
      run: async (c, s) => {
        const row = (await q("select customer_id from ssh_keys where id = $1", [s.keyId])).rows[0];
        if (row === undefined) return "not_found";
        if (row.customer_id !== c) return "forbidden";
        await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]);
        return "deleted";
      },
    },
    "cross-write",
    "another answer for a row of customer A than for a missing row",
    ["cross-write"],
  ],
  [
    "a write that answers with the id of a row of customer A",
    {
      name: "echoWrite",
      kind: "write",
      run: async (c, s) => {
        const { rowCount } = await q("delete from ssh_keys where id = $1 and customer_id = $2", [
          s.keyId,
          c,
        ]);
        return { deleted: rowCount, id: s.keyId };
      },
    },
    "cross-write",
    "names a row of customer A",
    ["cross-write"],
  ],
])("finds %s", async (_, c, checkName, detail, allChecks) => {
  const findings = await check(c);
  expect(findings).toContainEqual({
    case: c.name,
    check: checkName,
    detail: expect.stringContaining(detail),
  });
  // Exactly these findings, in this order: no extra, no wrong, no double one.
  expect(findings.map((f) => f.check)).toEqual(allChecks);
});

it("expectTenantIsolation names the failing case", async () => {
  await expect(
    expectTenantIsolation({
      pool: t.pool,
      seed,
      cases: [{ name: "blind", kind: "read", run: async () => null }],
    }),
  ).rejects.toThrow(/^tenant isolation failed:\nblind own-read: /);
});

it("expectTenantIsolation lists every finding, one per line: the text is exact", async () => {
  const blind: TenantCase<S> = { name: "blind", kind: "read", run: async () => null };
  const noop: TenantCase<S> = { name: "noop", kind: "write", run: async () => "ok" };
  await expect(expectTenantIsolation({ pool: t.pool, seed, cases: [blind, noop] })).rejects.toThrow(
    new Error(
      "tenant isolation failed:\n" +
        "blind own-read: customer A does not find its own rows; the case proves nothing\n" +
        "noop own-write: the write of customer A on its own rows changed nothing; the case proves nothing",
    ),
  );
});

it("expectTenantIsolation resolves when there is no finding", async () => {
  await expect(
    expectTenantIsolation({ pool: t.pool, seed, cases: [scopedGet] }),
  ).resolves.toBeUndefined();
});

it("runs every run one after another, never in parallel (a recorded statement belongs to one actor)", async () => {
  let running = 0;
  let overlap = 0;
  const order: string[] = [];
  const traced = (name: string): TenantCase<S> => ({
    name,
    kind: "read",
    run: async (c, s) => {
      order.push(name);
      overlap = Math.max(overlap, ++running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return (
        (await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
          .rows[0] ?? null
      );
    },
  });
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed,
    cases: [traced("one"), traced("two")],
  });
  expect(findings).toEqual([]);
  expect(overlap).toBe(1);
  expect(order).toContain("two");
  expect(order).toEqual([...order].sort()); // every run of "one" comes before the first run of "two"
});

it("ghostOf replaces every UUID consistently and keeps everything else", () => {
  const id = uuidv7();
  const g = ghostOf({ a: id, list: [id, "text", 3], nested: { b: id, n: null } });
  expect(g.a).not.toBe(id);
  expect(g.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(g).toEqual({ a: g.a, list: [g.a, "text", 3], nested: { b: g.a, n: null } });
});

it("ghostOf also replaces a UUID that is a key, and leaves its input as it was", () => {
  const id = uuidv7();
  const target = { byId: { [id]: { id } } };
  const g = ghostOf(target);
  const keys = Object.keys(g.byId);
  expect(keys).toHaveLength(1);
  const key = keys[0] as string;
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(key).not.toBe(id);
  expect(g.byId[key]).toEqual({ id: key });
  expect(target).toEqual({ byId: { [id]: { id } } });
});

it("unscopedStatements reports a statement about a tenant table without the actor as a parameter", () => {
  const a = uuidv7();
  const s = (sql: string, params: unknown[]) => ({ sql, params, actor: a });
  expect(
    unscopedStatements([
      s('select "id" from "ssh_keys" where "id" = $1', [uuidv7()]),
      s('select "id" from "ssh_keys" where "id" = $1 and "customer_id" = $2', [uuidv7(), a]),
      s("begin isolation level read committed", []),
      s('select "customer_id" from "markets"', []),
      s("select 1 from operations o", ["customer:" + a + ":k"]),
      // No parameter at all. drizzle-orm 0.45.4 turns a plain string given to tx.execute("...") into
      // raw SQL, which the lint rule on sql.raw does not see: this audit is the check that catches it.
      s("select * from ssh_keys", []),
    ]).map((x) => x.sql),
  ).toEqual([
    'select "id" from "ssh_keys" where "id" = $1',
    "select 1 from operations o",
    "select * from ssh_keys",
  ]);
});

it("unscopedStatements judges only a statement with an actor, names a table as a whole identifier, and ignores case", () => {
  const a = uuidv7();
  const stmt = (sql: string, actor: string | null = a) => ({ sql, params: [], actor });
  expect(
    unscopedStatements([
      stmt("select * from ssh_keys", null), // no actor: no customer to be scoped to
      stmt("select * from my_ssh_keys"), // a longer identifier is another name
      stmt(
        "insert into t values (1) on conflict on constraint ssh_keys_customer_id_fingerprint_unique do nothing",
      ),
      stmt("select * from public.ssh_keys"),
      stmt('select * from "public"."ssh_keys"'),
      stmt("SELECT * FROM SSH_KEYS"), // PostgreSQL folds an unquoted name to lower case
    ]).map((x) => x.sql),
  ).toEqual([
    "select * from public.ssh_keys",
    'select * from "public"."ssh_keys"',
    "SELECT * FROM SSH_KEYS",
  ]);
});

it("unscopedStatements looks only at the tables it is given", () => {
  const stmt = { sql: "select * from ssh_keys", params: [], actor: uuidv7() };
  expect(unscopedStatements([stmt], ["operations"])).toEqual([]);
  expect(unscopedStatements([stmt], ["operations", "ssh_keys"])).toEqual([stmt]);
});

it("statementsWithInlinedIds reports a statement with an actor whose text holds a whole UUID, and nothing else", () => {
  const a = uuidv7();
  const other = uuidv7();
  const s = (sql: string, params: unknown[] = [], actor: string | null = a) => ({
    sql,
    params,
    actor,
  });
  expect(
    statementsWithInlinedIds([
      s(`select "id" from "ssh_keys" where "customer_id" = '${a}'`), // the id written into the text
      s(`select "id" from "ssh_keys" where "customer_id" = '${other.toUpperCase()}'`), // upper case
      s(`select 1 from ssh_keys where customer_id = $1 or id = '${other}'`, [a]), // actor bound too
      s('select "id" from "ssh_keys" where "customer_id" = $1', [a]), // the same with a parameter
      s(`select 1 from ssh_keys where customer_id = '${a}'`, [], null), // no actor: not judged
      s(`select '0${a}'`), // nine digits in the first group: a longer hex string
      s(`select '${a}a'`), // thirteen digits in the last group: a longer hex string
      s("select 1 from ssh_keys"), // no id at all
    ]).map((x) => x.sql),
  ).toEqual([
    `select "id" from "ssh_keys" where "customer_id" = '${a}'`,
    `select "id" from "ssh_keys" where "customer_id" = '${other.toUpperCase()}'`,
    `select 1 from ssh_keys where customer_id = $1 or id = '${other}'`,
  ]);
});

it("statementsWithInlinedIds finds what unscopedStatements cannot: the actor is bound and another id is written into the text", () => {
  const a = uuidv7();
  const stmt = {
    sql: `select 1 from ssh_keys where customer_id = $1 or customer_id = '${uuidv7()}'`,
    params: [a],
    actor: a,
  };
  expect(unscopedStatements([stmt])).toEqual([]);
  expect(statementsWithInlinedIds([stmt])).toEqual([stmt]);
});
