import { beforeAll, expect, it } from "vitest";
import type { Tx } from "../client";
import { isStorableFxRate, readFxRateInForce, readFxRates } from "../repositories/config/fx-rates";
import {
  readPricingRuleById,
  readPricingRuleInForce,
  readPricingRules,
} from "../repositories/config/pricing-rules";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const name = (row: { steps: unknown[] } | null) =>
  row === null ? null : (row.steps[0] as { name: string }).name;

beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  await ensureMarket(t.pool, "KE");
  const fx = (market: string, rate: string, from: string) =>
    insertRow(t.pool, "fx_rates", { market, rate, effective_from: from });
  await fx("BD", "127", "2026-11-01T00:00:00Z");
  await fx("BD", "130.5", "2026-11-10T00:00:00Z");
  await fx("BD", "131", "2026-12-01T00:00:00.000500Z"); // half a millisecond after 2026-12-01T00:00:00.000Z
  await fx("KE", "1.25", "2026-11-05T00:00:00Z");
  const rule = (family: string | null, from: string, n: string) =>
    insertRow(t.pool, "pricing_rules", {
      market: "BD",
      product_family: family,
      steps: JSON.stringify([{ name: n }]),
      effective_from: from,
    });
  await rule(null, "2026-03-01T00:00:00Z", "M1");
  await rule("linux_instance", "2026-04-01T00:00:00Z", "F1");
  await rule(null, "2026-05-01T00:00:00Z", "M2");
});

it.each([
  ["one millisecond before the first rate", "2026-10-31T23:59:59.999Z", null],
  ["exactly at the first rate", "2026-11-01T00:00:00.000Z", "127"],
  ["between two rates", "2026-11-09T23:59:59.999Z", "127"],
  ["exactly at the second rate", "2026-11-10T00:00:00.000Z", "130.5"],
  ["half a millisecond before the third", "2026-12-01T00:00:00.000Z", "130.5"],
  ["one millisecond after the third", "2026-12-01T00:00:00.001Z", "131"],
])("the rate in force: %s", async (_, at, rate) => {
  const row = await as("web_rw", (tx) => readFxRateInForce(tx, "BD", new Date(at)));
  expect(row?.rate ?? null).toBe(rate);
});

it("a rate row has the market, the canonical text, the start as a Date and a UUID v7 id", async () => {
  const row = await as("web_rw", (tx) =>
    readFxRateInForce(tx, "BD", new Date("2026-11-01T00:00:00Z")),
  );
  expect(row).toEqual({
    id: expect.stringMatching(UUID),
    market: "BD",
    rate: "127",
    effectiveFrom: new Date("2026-11-01T00:00:00.000Z"),
  });
});

it("each market has its own rates", async () => {
  const at = new Date("2026-11-06T00:00:00Z");
  expect((await as("web_rw", (tx) => readFxRateInForce(tx, "KE", at)))?.rate).toBe("1.25");
  expect((await as("web_rw", (tx) => readFxRateInForce(tx, "BD", at)))?.rate).toBe("127");
});

it.each(["web_rw", "admin_rw", "worker_rw"] as const)(
  "%s reads the rate and the rule in force (migration 0006 grants the same columns)",
  async (role) => {
    const at = new Date("2026-11-20T00:00:00Z");
    expect((await as(role, (tx) => readFxRateInForce(tx, "BD", at)))?.rate).toBe("130.5");
    expect(name(await as(role, (tx) => readPricingRuleInForce(tx, "BD", null, at)))).toBe("M2");
  },
);

it("report_ro has no grant on these tables: the read fails with a DbError and never answers null", async () => {
  await expect(
    as("report_ro", (tx) => readFxRateInForce(tx, "BD", new Date())),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("a market that is not two capital letters, or has no rate, has nothing in force", async () => {
  const at = new Date("2026-12-31T00:00:00Z");
  for (const market of ["bd", "BD'; --", "ZZ"])
    expect(await as("web_rw", (tx) => readFxRateInForce(tx, market, at)), market).toBeNull();
  expect(await as("web_rw", (tx) => readFxRates(tx, "zz"))).toEqual([]);
});

it("an instant that is not a valid date is a programming error, not 'nothing in force'", async () => {
  await expect(as("web_rw", (tx) => readFxRateInForce(tx, "BD", new Date("nope")))).rejects.toThrow(
    new TypeError("readFxRateInForce: at: not a valid date"),
  );
  await expect(
    as("web_rw", (tx) => readPricingRuleInForce(tx, "BD", null, new Date("nope"))),
  ).rejects.toThrow(new TypeError("readPricingRuleInForce: at: not a valid date"));
});

it("the history is newest first, limited, and shows scheduled rows too", async () => {
  expect((await as("admin_rw", (tx) => readFxRates(tx, "BD"))).map((r) => r.rate)).toEqual([
    "131",
    "130.5",
    "127",
  ]);
  expect((await as("admin_rw", (tx) => readFxRates(tx, "BD", 2))).map((r) => r.rate)).toEqual([
    "131",
    "130.5",
  ]);
  expect(await as("admin_rw", (tx) => readFxRates(tx, "BD", 1000))).toHaveLength(3);
  await expect(as("admin_rw", (tx) => readFxRates(tx, "BD", 0))).rejects.toThrow(
    new TypeError("limit: not a whole number above 0"),
  );
  expect((await as("admin_rw", (tx) => readPricingRules(tx, "BD"))).map(name)).toEqual([
    "M2",
    "F1",
    "M1",
  ]);
});

it.each([
  [
    "a family before it has its own rule gets the market rule",
    "linux_instance",
    "2026-03-15T00:00:00Z",
    "M1",
  ],
  [
    "a family keeps its own rule although a newer market rule exists",
    "linux_instance",
    "2026-06-01T00:00:00Z",
    "F1",
  ],
  ["another family gets the newest market rule", "windows_instance", "2026-06-01T00:00:00Z", "M2"],
  [
    "another family before the newest market rule",
    "windows_instance",
    "2026-04-15T00:00:00Z",
    "M1",
  ],
  ["no family asks for the market rule", null, "2026-06-01T00:00:00Z", "M2"],
  ["nothing is in force before the first rule", "linux_instance", "2026-02-01T00:00:00Z", null],
])("the rule in force: %s", async (_, family, at, expected) => {
  expect(
    name(await as("web_rw", (tx) => readPricingRuleInForce(tx, "BD", family, new Date(at)))),
  ).toBe(expected);
});

it("a rule row has its id as the version, the family and the start", async () => {
  const row = await as("web_rw", (tx) =>
    readPricingRuleInForce(tx, "BD", "linux_instance", new Date("2026-06-01T00:00:00Z")),
  );
  expect(row).toEqual({
    id: expect.stringMatching(UUID),
    market: "BD",
    productFamily: "linux_instance",
    steps: [{ name: "F1" }],
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
  });
});

it("the rule named by a snapshot's ruleVersion is read by its id, as each of the three roles", async () => {
  const inForce = await as("web_rw", (tx) =>
    readPricingRuleInForce(tx, "BD", "linux_instance", new Date("2026-06-01T00:00:00Z")),
  );
  for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
    expect(await as(role, (tx) => readPricingRuleById(tx, inForce!.id)), role).toEqual(inForce);
  }
  const older = (await as("admin_rw", (tx) => readPricingRules(tx, "BD"))).at(-1)!; // M1, no longer in force
  expect(name(await as("web_rw", (tx) => readPricingRuleById(tx, older.id)))).toBe("M1");
});

it("an id that is not a UUID, or names no rule, gives null (a bad id is never sent to SQL)", async () => {
  for (const id of ["", "not-an-id", "x'; drop table pricing_rules; --"]) {
    expect(await as("web_rw", (tx) => readPricingRuleById(tx, id)), id).toBeNull();
  }
  expect(
    await as("web_rw", (tx) => readPricingRuleById(tx, "01900000-0000-7000-8000-000000000000")),
  ).toBeNull();
});

it("a family name that is not a plain word has no rule (and is never sent to SQL as text)", async () => {
  const at = new Date("2026-06-01T00:00:00Z");
  for (const family of ["Linux Instance", "x'; drop table fx_rates; --"]) {
    expect(
      await as("web_rw", (tx) => readPricingRuleInForce(tx, "BD", family, at)),
      family,
    ).toBeNull();
  }
});

it.each([
  ["127", true],
  ["124.77", true],
  ["0.5", true],
  ["999999.999999", true],
  ["127.0", true],
  ["", false],
  ["0", false],
  ["0.000000", false],
  ["-1", false],
  ["127.1234567", false],
  ["1000000", false],
  ["00.5", false],
  [127, false],
])("isStorableFxRate(%j) is %s", (text, ok) => {
  expect(isStorableFxRate(text)).toBe(ok);
});
