import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { checkTenantIsolation, ghostOf, type TenantCase } from "../testing/cross-tenant";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newResource, uniqueSuffix } from "./fixtures";

// The request about a row that does not exist (the ghost), and the ids that belong to customer A.
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

// ---- ghostOf ----------------------------------------------------------------------------------

it("ghostOf gives every id of an array its own replacement, also when ids follow each other", () => {
  const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
  const g = ghostOf({ ids: [a, b, a, b, c, c] });
  expect(g.ids).toHaveLength(6);
  expect(g.ids.some((id, i) => id === [a, b, a, b, c, c][i])).toBe(false); // none is left real
  expect(g.ids[0]).toBe(g.ids[2]);
  expect(g.ids[1]).toBe(g.ids[3]);
  expect(g.ids[4]).toBe(g.ids[5]);
  expect(new Set(g.ids).size).toBe(3);
});

it("ghostOf replaces an id in upper case, and replaces it like the same id in lower case", () => {
  const id = uuidv7();
  const g = ghostOf({ lower: id, upper: id.toUpperCase() });
  expect(g.upper).not.toBe(id.toUpperCase());
  expect(g.upper).toBe(g.lower);
  expect(g.lower).not.toBe(id);
});

it("ghostOf keeps an id inside a longer string as it is (the check of the helper refuses such a ghost)", () => {
  const id = uuidv7();
  const target = {
    embedded: `customer:${id}:key`,
    prefixed: `${id}-suffix`,
    path: `/servers/${id}`,
    braces: `{${id}}`,
    urn: `urn:uuid:${id}`,
    noHyphen: id.replaceAll("-", ""),
  };
  expect(ghostOf(target)).toEqual(target);
});

it("ghostOf keeps a Date, a Map and an instance of a class by identity", () => {
  class Box {
    constructor(public x: number) {}
  }
  const date = new Date(0);
  const map = new Map([["k", 1]]);
  const box = new Box(1);
  const g = ghostOf({ date, map, box });
  expect(g.date).toBe(date);
  expect(g.map).toBe(map);
  expect(g.box).toBe(box);
});

it("ghostOf copies an object with a null prototype and replaces its ids", () => {
  const id = uuidv7();
  const nullPrototype = Object.assign(Object.create(null) as object, { id }) as { id: string };
  const g = ghostOf({ nullPrototype });
  expect(g.nullPrototype).not.toBe(nullPrototype);
  expect(g.nullPrototype.id).not.toBe(id);
  expect(g.nullPrototype.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
});

it("ghostOf makes new ids on every call, but one id keeps one replacement inside a call", () => {
  const id = uuidv7();
  const first = ghostOf({ a: id, b: [id], c: { d: id } });
  expect([first.a, first.b[0], first.c.d]).toEqual([first.a, first.a, first.a]);
  expect(ghostOf({ a: id }).a).not.toBe(first.a);
});

// ---- a ghost that is still a row of customer A (B1) -------------------------------------------

it("refuses a target whose id sits inside a longer string: its ghost would be the real request", async () => {
  type P = { path: string };
  let runs = 0;
  const pathCase: TenantCase<P> = {
    name: "pathCase",
    kind: "write",
    run: async () => {
      runs++;
      return "x";
    },
  };
  const pathSeed = async (pool: typeof t.pool, c: string): Promise<P> => ({
    path: `/servers/${(await seed(pool, c)).keyId}`,
  });
  const outcome = checkTenantIsolation({ pool: t.pool, seed: pathSeed, cases: [pathCase] });
  await expect(outcome).rejects.toThrow(
    /the ghost of case pathCase still holds an id of customer A/,
  );
  await expect(outcome).rejects.toThrow(/whole UUID/);
  expect(runs).toBe(0); // no run happened, so no verdict could be false
});

it("the refusal does not print the id", async () => {
  type P = { path: string };
  let keyId = "";
  const pathSeed = async (pool: typeof t.pool, c: string): Promise<P> => {
    const s = await seed(pool, c);
    keyId = s.keyId;
    return { path: `/servers/${s.keyId}` };
  };
  const error = await checkTenantIsolation({
    pool: t.pool,
    seed: pathSeed,
    cases: [{ name: "pathCase", kind: "read", run: async () => null }],
  }).catch((e: unknown) => e as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(keyId);
});

it("refuses a ghost that the case built and that still holds an id of customer A", async () => {
  const keeps: TenantCase<S> = {
    name: "keeps",
    kind: "read",
    ghost: (target) => target,
    run: async () => null,
  };
  await expect(check(keeps)).rejects.toThrow(/the ghost of case keeps still holds an id/);
});

it("refuses a ghost that keeps only the customer id of A", async () => {
  type C = { customerId: string };
  const keepsCustomer: TenantCase<C> = {
    name: "keepsCustomer",
    kind: "read",
    ghost: (target) => ({ ...target }),
    run: async () => null,
  };
  await expect(
    checkTenantIsolation({
      pool: t.pool,
      seed: async (_pool, customerId) => ({ customerId }),
      cases: [keepsCustomer],
    }),
  ).rejects.toThrow(/the ghost of case keepsCustomer still holds an id/);
});

// A fingerprint is a natural key: ghostOf keeps it, so the case says how to make another one.
type K = { fingerprint: string };
const keySeed = async (pool: typeof t.pool, c: string): Promise<K> => {
  const fingerprint = "SHA256:" + uniqueSuffix();
  await insertRow(pool, "ssh_keys", {
    customer_id: c,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint,
  });
  return { fingerprint };
};
const otherFingerprint = (): K => ({ fingerprint: "SHA256:" + uniqueSuffix() });
const byFingerprint = (
  run: TenantCase<K>["run"],
  ghost?: TenantCase<K>["ghost"],
): TenantCase<K> => ({ name: "byFingerprint", kind: "write", ...(ghost ? { ghost } : {}), run });
const leakyByFingerprint: TenantCase<K>["run"] = async (c, s) => {
  const row = (await q("select customer_id from ssh_keys where fingerprint = $1", [s.fingerprint]))
    .rows[0];
  if (row === undefined) return "not_found";
  if (row.customer_id !== c) return "forbidden"; // an existence leak
  await q("delete from ssh_keys where fingerprint = $1 and customer_id = $2", [s.fingerprint, c]);
  return "deleted";
};
const scopedByFingerprint: TenantCase<K>["run"] = async (c, s) =>
  (await q("delete from ssh_keys where fingerprint = $1 and customer_id = $2", [s.fingerprint, c]))
    .rowCount
    ? "deleted"
    : "not_found";

it("finds the existence leak of a natural key when the case declares its ghost", async () => {
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed: keySeed,
    cases: [byFingerprint(leakyByFingerprint, otherFingerprint)],
  });
  expect(findings).toEqual([
    {
      case: "byFingerprint",
      check: "cross-write",
      detail: expect.stringContaining('{"returned":"forbidden"} | {"returned":"not_found"}'),
    },
  ]);
});

it("a correct natural-key case passes when it declares its ghost", async () => {
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed: keySeed,
    cases: [byFingerprint(scopedByFingerprint, otherFingerprint)],
  });
  expect(findings).toEqual([]);
});

it("hands the seeded target of customer A to the ghost of the case, and runs the ghost runs on its result", async () => {
  const handed: K[] = [];
  const runsOn: string[] = [];
  const ghostFingerprint = "SHA256:ghost-" + uniqueSuffix();
  await checkTenantIsolation({
    pool: t.pool,
    seed: keySeed,
    cases: [
      byFingerprint(
        async (c, s) => {
          runsOn.push(s.fingerprint);
          return scopedByFingerprint(c, s);
        },
        (target) => {
          handed.push(target);
          return { fingerprint: ghostFingerprint };
        },
      ),
    ],
  });
  expect(handed).toHaveLength(1); // once per case
  const real = handed[0]?.fingerprint as string;
  expect(real).toMatch(/^SHA256:[0-9a-f]{8}$/);
  // Write order: B on the rows of A, B on the ghost, A on its rows.
  expect(runsOn).toEqual([real, ghostFingerprint, real]);
});

it("a target with an id inside a string passes when the case builds its ghost itself", async () => {
  type P = { path: string };
  const idOf = (path: string) => path.slice("/servers/".length);
  const pathCase: TenantCase<P> = {
    name: "pathCase",
    kind: "write",
    ghost: () => ({ path: `/servers/${uuidv7()}` }),
    run: async (c, s) =>
      (await q("delete from ssh_keys where id = $1 and customer_id = $2", [idOf(s.path), c]))
        .rowCount
        ? "deleted"
        : "not_found",
  };
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed: async (pool, c) => ({ path: `/servers/${(await seed(pool, c)).keyId}` }),
    cases: [pathCase],
  });
  expect(findings).toEqual([]);
});

// ---- the ids that belong to customer A (C7) ----------------------------------------------------

it("knows every id of the seed: a write that answers with the SECOND id is found", async () => {
  const echoSecond: TenantCase<S> = {
    name: "echoSecond",
    kind: "write",
    run: async (c, s) => {
      const { rowCount } = await q("delete from ssh_keys where id = $1 and customer_id = $2", [
        s.keyId,
        c,
      ]);
      return { deleted: rowCount, resource: s.resourceId };
    },
  };
  expect(await check(echoSecond)).toEqual([
    {
      case: "echoSecond",
      check: "cross-write",
      detail: "the answer to customer B names a row of customer A",
    },
  ]);
});

it("knows every id of the seed: a read that mixes a scoped get with an unscoped list of resources is found", async () => {
  const mixed: TenantCase<S> = {
    name: "mixed",
    kind: "read",
    run: async (c, s) => ({
      mine: (await q("select id from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]))
        .rows[0],
      resources: (await q("select id from resources order by id", [])).rows,
    }),
  };
  expect(await check(mixed)).toEqual([
    {
      case: "mixed",
      check: "cross-read",
      detail: "the answer to customer B names a row of customer A",
    },
  ]);
});

it("knows the customer id of A as well: a write that lists the owners of every key is found", async () => {
  const listsOwners: TenantCase<S> = {
    name: "listsOwners",
    kind: "write",
    run: async (c, s) => {
      await q("delete from ssh_keys where id = $1 and customer_id = $2", [s.keyId, c]);
      return (await q("select customer_id from ssh_keys order by id", [])).rows;
    },
  };
  // The answer of B holds the customer id of A, which the seed does not (it holds two other ids).
  expect(await checks(listsOwners)).toEqual(["cross-write"]);
});

// A seed that holds no id at all: the customer id is then the only id of customer A.
type NoIds = { note: string };
const seedWithoutIds = async (pool: typeof t.pool, c: string): Promise<NoIds> => {
  await insertRow(pool, "ssh_keys", {
    customer_id: c,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:" + uniqueSuffix(),
  });
  return { note: "no id here" };
};
const withoutIds = (run: TenantCase<NoIds>["run"]): Promise<string[]> =>
  checkTenantIsolation({
    pool: t.pool,
    seed: seedWithoutIds,
    cases: [{ name: "withoutIds", kind: "read", run }],
  }).then((findings) => findings.map((f) => f.check));

it("when the seed holds no id, the customer id alone is the id of customer A: a leak of it is found", async () => {
  expect(
    await withoutIds(
      async () => (await q("select customer_id from ssh_keys order by id", [])).rows,
    ),
  ).toEqual(["cross-read"]);
});

it("when the seed holds no id, a read that answers with its own customer id passes", async () => {
  expect(
    await withoutIds(
      async (c) => (await q("select customer_id from ssh_keys where customer_id = $1", [c])).rows,
    ),
  ).toEqual([]);
});
