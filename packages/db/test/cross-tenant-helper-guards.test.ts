import type pg from "pg";
import { expect, it } from "vitest";
import {
  checkTenantIsolation,
  expectTenantIsolation,
  type TenantCase,
} from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// What the helper refuses before it writes anything (R16), and what it promises about its inputs.
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
const scopedGet: TenantCase<S> = {
  name: "scopedGet",
  kind: "read",
  run: async (c, s) =>
    (await q("select id, name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
      .rows[0] ?? null,
};

// A pool that answers one question, "which database am I?", and fails on anything else, so that a
// refusal that comes late (after a customer was inserted) shows up as another error.
const fakePool = (database: string | undefined) => {
  const queries: string[] = [];
  const pool = {
    query: async (text: string) => {
      queries.push(text);
      if (/current_database/i.test(text)) {
        return { rows: database === undefined ? [] : [{ current_database: database }] };
      }
      throw new Error(`the helper sent a query before it checked the database: ${text}`);
    },
  } as unknown as pg.Pool;
  return { pool, queries };
};

it("no case is not a pass: both functions refuse an empty list before any query", async () => {
  const { pool, queries } = fakePool("tc_test_1_abcdef12");
  await expect(checkTenantIsolation({ pool, seed, cases: [] })).rejects.toThrow(
    /^tenant isolation: no case given$/,
  );
  await expect(expectTenantIsolation({ pool, seed, cases: [] })).rejects.toThrow(
    /^tenant isolation: no case given$/,
  );
  expect(queries).toEqual([]);
});

it("refuses a case of an unknown kind with a TypeError that names the case, before it seeds anything", async () => {
  const seeds: string[] = [];
  const spySeed = async (pool: typeof t.pool, c: string): Promise<S> => {
    seeds.push(c);
    return seed(pool, c);
  };
  const typo = {
    name: "typoCase",
    kind: "wirte",
    run: async () => "ok",
  } as unknown as TenantCase<S>;
  const missing = { name: "noKind", run: async () => "ok" } as unknown as TenantCase<S>;
  const check = (c: TenantCase<S>) =>
    checkTenantIsolation({ pool: t.pool, seed: spySeed, cases: [scopedGet, c] });
  // The valid case comes first: not even its customers are made.
  await expect(check(typo)).rejects.toThrow(TypeError);
  await expect(check(typo)).rejects.toThrow(/typoCase.*"wirte".*read, write or self-write/);
  await expect(check(missing)).rejects.toThrow(/noKind.*undefined.*read, write or self-write/);
  expect(seeds).toEqual([]);
});

// The name that createTempDatabase gives a database is tc_test_<pid>_<8 lower-case hex digits>.
it.each([
  ["postgres"],
  ["ticon"],
  ["tc_test_abc_abcdef12"], // a process id that is no number
  ["tc_test__abcdef12"], // no process id
  ["tc_test_1_abcdef1"], // seven hex digits
  ["tc_test_1_abcdef123"], // nine hex digits
  ["tc_test_1_ABCDEF12"], // upper case
  ["tc_test_1_abcdefgh"], // not hex
  ["xtc_test_1_abcdef12"], // something in front
  ["tc_test_1_abcdef12x"], // something behind
  ["tc_test_1_abcdef12\n"], // a line feed behind
  [undefined], // no answer at all
])("refuses a pool whose database is %j, before it writes", async (database) => {
  const { pool, queries } = fakePool(database);
  const outcome = checkTenantIsolation({ pool, seed, cases: [scopedGet] });
  await expect(outcome).rejects.toThrow(/not a throwaway test database/);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatch(/current_database/i);
});

it("the refusal of a pool names the database it found, and nothing else", async () => {
  const { pool } = fakePool("ticon_dev");
  await expect(checkTenantIsolation({ pool, seed, cases: [scopedGet] })).rejects.toThrow(
    /"ticon_dev"/,
  );
});

it("every run gets its own copy of the target: a run that damages its target changes nothing for the later runs", async () => {
  const seen: string[] = [];
  const damaging: TenantCase<S> = {
    name: "damaging",
    kind: "read",
    run: async (_c, s) => {
      seen.push(JSON.stringify(s));
      s.keyId = "damaged";
      s.resourceId = "damaged";
      return null;
    },
  };
  await checkTenantIsolation({ pool: t.pool, seed, cases: [damaging] });
  expect(seen).toHaveLength(4); // B on the rows of A, B on the ghost, A on its rows, A on the ghost
  expect(seen.filter((text) => text.includes("damaged"))).toEqual([]);
  // Two runs on the real target saw the same thing, and so did the two runs on the ghost.
  expect(new Set(seen).size).toBe(2);
});

it("every case gets two fresh customers, and both are seeded", async () => {
  const seeded: string[] = [];
  const seen: Record<string, Set<string>> = {};
  const spyCase = (name: string): TenantCase<S> => ({
    name,
    kind: "read",
    run: async (c, s) => {
      (seen[name] ??= new Set()).add(c);
      return (
        (await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
          .rows[0] ?? null
      );
    },
  });
  await checkTenantIsolation({
    pool: t.pool,
    seed: async (pool, c) => {
      seeded.push(c);
      return seed(pool, c);
    },
    cases: [spyCase("one"), spyCase("two")],
  });
  expect(seeded).toHaveLength(4); // A and B of the first case, A and B of the second
  expect(new Set(seeded).size).toBe(4);
  expect([...(seen.one ?? [])].some((id) => seen.two?.has(id))).toBe(false);
  // The first customer of a case is A: it is the one the case reads as the owner.
  expect(seen.one?.has(seeded[0] as string)).toBe(true);
  expect(seen.two?.has(seeded[2] as string)).toBe(true);
});
