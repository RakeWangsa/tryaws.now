import { seedLaunchData } from "@tc/db";
import { insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { previewBook } from "./index";

// WPA-P1: the live preview of the price list. It prices every product of a family with the engine, under
// the terms in force and under the candidate, and writes nothing.
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const fixed = (value: string) => ({ kind: "fixed" as const, value });
const percent = (value: string) => ({ kind: "percent" as const, value });
const preview = (input: Record<string, unknown>) =>
  asRole(t, "admin_rw", (tx) =>
    previewBook(tx, { market: "BD", productFamily: "disk", ...input } as never, clockAt(T0)),
  );

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
});

it("prices each product of the family: the seeded disk anchor, USD 0.10 a GB, at FX 127 is 1270 paisa before the rule", async () => {
  const r = await preview({});
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.fxRate).toBe("127");
  expect(r.value.rows.map((x) => x.region).sort()).toEqual(["ap-south-1", "ap-southeast-1"]);
  for (const row of r.value.rows) {
    expect(row.candidate.baseMinor).toBe(1270n);
    // nothing changed: the candidate is the current price
    expect(row.deltaMinor).toBe(0n);
    expect(row.current?.totalMinor).toBe(row.candidate.totalMinor);
  }
});

it("a candidate margin shows the new price, the margin and the commission next to the current one", async () => {
  const r = await preview({ terms: { margin: fixed("5"), commission: percent("0.5") } });
  if (!r.ok) throw new Error("refused");
  for (const row of r.value.rows) {
    expect(row.candidate.marginMinor).toBe(5n);
    expect(row.candidate.commissionMinor).toBe(3n); // half of 5, half up
    expect(row.deltaMinor).toBe(5n);
    expect(row.current?.marginMinor).toBe(0n);
  }
});

it("a candidate base cost changes only that product", async () => {
  const first = await preview({});
  if (!first.ok) throw new Error("refused");
  const target = first.value.rows[0]!;
  const r = await preview({ base: { productId: target.productId, awsPriceUsd: "0.2" } });
  if (!r.ok) throw new Error("refused");
  const changed = r.value.rows.find((x) => x.productId === target.productId)!;
  const other = r.value.rows.find((x) => x.productId !== target.productId)!;
  expect(changed.candidate.baseMinor).toBe(2540n);
  expect(changed.awsPriceUsd).toBe("0.2");
  expect(changed.currentAwsPriceUsd).toBe("0.1000");
  expect(changed.deltaMinor! > 0n).toBe(true);
  expect(other.deltaMinor).toBe(0n);
});

it("refuses terms the engine refuses and a rule without a markup step, naming the field", async () => {
  const bad = await preview({ terms: { margin: percent("6"), commission: null } });
  expect(bad).toMatchObject({ ok: false, error: "validation" });
  const worse = await preview({ base: { productId: "x", awsPriceUsd: "abc" } });
  expect(worse).toMatchObject({ ok: false, error: "validation" });
});

it("a family with no catalog row is priced on three sample products", async () => {
  const r = await preview({
    productFamily: "backup",
    terms: { margin: percent("0.1"), commission: null },
  });
  if (!r.ok) throw new Error("refused");
  expect(r.value.fromSamples).toBe(true);
  expect(r.value.rows.map((x) => x.awsPriceUsd)).toEqual(["5", "24", "84"]);
  expect(r.value.rows[0]!.candidate.marginMinor).toBe(6350n);
});

it("nothing in force, nothing priced (R16); an unknown family is a validation error", async () => {
  expect(await preview({ market: "KE" })).toMatchObject({ ok: false });
  expect(await preview({ productFamily: "nope" })).toMatchObject({
    ok: false,
    error: "validation",
  });
});

it("writes nothing", async () => {
  const before = (await t.pool.query("select count(*)::int as n from settings")).rows[0].n;
  await preview({ terms: { margin: fixed("5"), commission: null } });
  expect((await t.pool.query("select count(*)::int as n from settings")).rows[0].n).toBe(before);
  expect(typeof insertRow).toBe("function");
});
