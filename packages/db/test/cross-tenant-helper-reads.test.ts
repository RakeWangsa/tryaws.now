import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { checkTenantIsolation, type TenantCase } from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// Reads: what an own-read needs, how answers are compared (ids, order of keys, amounts), and the
// text of what the helper reports.
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
const checks = async (c: TenantCase<S>) => (await check(c)).map((f) => f.check);
const ownerOf = async (keyId: string): Promise<string | undefined> =>
  (await q("select customer_id from ssh_keys where id = $1", [keyId])).rows[0]?.customer_id;
const read = (name: string, run: TenantCase<S>["run"]): TenantCase<S> => ({
  name,
  kind: "read",
  run,
});
const scopedRow = async (c: string, s: S) =>
  (await q("select id, name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
    .rows[0] ?? null;

// ---- what a correct read looks like ------------------------------------------------------------

it("a correct list passes: customer A finds its rows through the ids in the answer, B gets its own", async () => {
  const list = read(
    "list",
    async (c) =>
      (
        await q("select id, name, fingerprint from ssh_keys where customer_id = $1 order by id", [
          c,
        ])
      ).rows,
  );
  expect(await check(list)).toEqual([]);
});

it("a list that lost its scope is found: its answer names the second id of the seed", async () => {
  const leakyList = read(
    "leakyList",
    async () => (await q("select id from resources order by id", [])).rows,
  );
  expect(await check(leakyList)).toEqual([
    {
      case: "leakyList",
      check: "cross-read",
      detail: "the answer to customer B names a row of customer A",
    },
  ]);
});

it("a read whose answer holds no id passes when it differs from the answer for a missing row", async () => {
  const nameOnly = read(
    "nameOnly",
    async (c, s) =>
      (await q("select name from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
        .rows[0] ?? null,
  );
  expect(await check(nameOnly)).toEqual([]);
});

it("a read that answers a count that follows the target passes", async () => {
  const countGet = read(
    "countGet",
    async (c, s) =>
      (
        await q("select count(*)::int as n from ssh_keys where id = $1 and customer_id = $2", [
          s.keyId,
          c,
        ])
      ).rows[0],
  );
  expect(await check(countGet)).toEqual([]);
});

it("a read that answers a count that ignores the target is blind", async () => {
  const countAll = read(
    "countAll",
    async (c) =>
      (await q("select count(*)::int as n from ssh_keys where customer_id = $1", [c])).rows[0],
  );
  expect(await checks(countAll)).toEqual(["own-read"]);
});

it("a leaky get is reported once, as a read that names a row of A", async () => {
  const leakyGet = read(
    "leakyGet",
    async (_c, s) =>
      (await q("select id, name from ssh_keys where id = $1", [s.keyId])).rows[0] ?? null,
  );
  expect(await check(leakyGet)).toEqual([
    {
      case: "leakyGet",
      check: "cross-read",
      detail: "the answer to customer B names a row of customer A",
    },
  ]);
});

it("an answer that holds only the customer id of A is found", async () => {
  const ownerOnly = read(
    "ownerOnly",
    async (_c, s) =>
      (await q("select customer_id from ssh_keys where id = $1", [s.keyId])).rows[0] ?? null,
  );
  expect(await checks(ownerOnly)).toEqual(["cross-read"]);
});

it("an id of A in upper case in the answer is found", async () => {
  const shouts = read("shouts", async (c, s) => {
    const row = await scopedRow(c, s);
    return { id: row === null ? null : s.keyId.toUpperCase(), seen: s.keyId.toUpperCase() };
  });
  expect(await checks(shouts)).toEqual(["cross-read"]);
});

// ---- blind reads (B5) --------------------------------------------------------------------------

it("a read that only echoes the actor is blind: the customer id of A is no proof when the seed holds other ids", async () => {
  const echoesActor = read("echoesActor", async (c) => ({ actor: c, found: false }));
  expect(await check(echoesActor)).toEqual([
    {
      case: "echoesActor",
      check: "own-read",
      detail: "customer A does not find its own rows; the case proves nothing",
    },
  ]);
});

it("a read that needs no id of the seed passes by the customer id when the seed holds none", async () => {
  const profileLike: TenantCase<Record<string, never>> = {
    name: "profileLike",
    kind: "read",
    run: async (c) => (await q("select id from customers where id = $1", [c])).rows[0] ?? null,
  };
  expect(
    await checkTenantIsolation({ pool: t.pool, seed: async () => ({}), cases: [profileLike] }),
  ).toEqual([]);
});

it("a read whose answer only carries a fresh id is still blind", async () => {
  const blindFresh = read("blindFresh", async () => ({ requestId: uuidv7() }));
  expect(await check(blindFresh)).toEqual([
    {
      case: "blindFresh",
      check: "own-read",
      detail: "customer A does not find its own rows; the case proves nothing",
    },
  ]);
});

it("a case that returns nothing is a finding, not a TypeError", async () => {
  expect(await checks(read("voidRead", async () => undefined))).toEqual(["own-read"]);
});

it("a seed that returns nothing ends in a finding", async () => {
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed: async () => undefined,
    cases: [{ name: "x", kind: "read", run: async () => null }],
  });
  expect(findings.map((f) => f.check)).toEqual(["own-read"]);
});

// ---- ids in an answer are not part of the comparison -------------------------------------------

const fresh = () => ({ requestId: uuidv7(), traceId: uuidv7().toUpperCase() });

it("answers that carry a different request id and trace id (upper case too) are the same answer: a read", async () => {
  const withFreshIds = read("withFreshIds", async (c, s) => ({
    row: await scopedRow(c, s),
    ...fresh(),
  }));
  expect(await check(withFreshIds)).toEqual([]);
});

it("answers that carry a different request id and trace id are the same answer: a write", async () => {
  const writeFresh: TenantCase<S> = {
    name: "writeFresh",
    kind: "write",
    run: async (c, s) => ({
      result: (await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
        .rowCount
        ? "deleted"
        : "not_found",
      ...fresh(),
    }),
  };
  expect(await check(writeFresh)).toEqual([]);
});

it("the order of the keys of an answer does not matter", async () => {
  let n = 0;
  const flipping = read("flipping", async (c, s) => {
    const row = await scopedRow(c, s);
    if (row !== null) return { id: row.id, a: 1, b: 2 };
    return n++ % 2 === 0 ? { a: 1, b: { x: 1, y: 2 } } : { b: { y: 2, x: 1 }, a: 1 };
  });
  expect(await check(flipping)).toEqual([]);
});

// ---- amounts are bigint paisa (R4) -------------------------------------------------------------

const balance = (scoped: boolean): TenantCase<S> =>
  read(scoped ? "balance" : "leakyBalance", async (c, s) => {
    const rows = scoped
      ? await q("select 1 from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c])
      : await q("select 1 from ssh_keys where id = $1", [s.keyId]);
    return { balance: rows.rowCount ? 1500n : 0n };
  });

it("two different amounts are two different answers: a scoped balance passes", async () => {
  expect(await check(balance(true))).toEqual([]);
});

it("two different amounts are two different answers: an unscoped balance is found", async () => {
  expect(await check(balance(false))).toEqual([
    {
      case: "leakyBalance",
      check: "cross-read",
      detail:
        "customer B gets another answer for a row of customer A than for a missing row: " +
        '{"returned":{"balance":"1500n"}} | {"returned":{"balance":"0n"}}',
    },
  ]);
});

it("two amounts that differ by one paisa are two different answers", async () => {
  const offByOne = read("offByOne", async (c, s) => {
    const owner = await ownerOf(s.keyId);
    if (owner === c) return { id: s.keyId, amount: 100n };
    return { amount: owner === undefined ? 100n : 101n };
  });
  expect(await check(offByOne)).toEqual([
    {
      case: "offByOne",
      check: "cross-read",
      detail: expect.stringContaining(
        '{"returned":{"amount":"101n"}} | {"returned":{"amount":"100n"}}',
      ),
    },
  ]);
});

// ---- the text of a finding ---------------------------------------------------------------------

it("the finding of a difference shows both answers, normalised and in this order: B on A's row | B on a missing row", async () => {
  const existence = read("existence", async (c, s) => {
    const owner = await ownerOf(s.keyId);
    return owner === undefined ? "not_found" : owner === c ? "mine" : "forbidden";
  });
  const findings = await check(existence);
  expect(findings).toEqual([
    {
      case: "existence",
      check: "cross-read",
      detail:
        "customer B gets another answer for a row of customer A than for a missing row: " +
        '{"returned":"forbidden"} | {"returned":"not_found"}',
    },
  ]);
});
