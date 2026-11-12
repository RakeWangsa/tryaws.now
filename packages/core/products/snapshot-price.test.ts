import { seedLaunchData } from "@tc/db";
import { ensureMarket, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { snapshotPrice } from "./snapshot-price";

// WPU-G9. The price of a stored snapshot: the config row `config_price.snapshot_gb_month` (Lightsail
// USD 0.05 per GB-month) through the pricing engine (R4). Needs the local PostgreSQL (pnpm db:up).
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
  await ensureMarket(t.pool, "KE");
});

it("prices one GB-month and a stored size with the engine, half up, in paisa", async () => {
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", 100, clockAt(T0)));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // 0.05 USD x 127 x 100 = 635 paisa before the rule; the rule of the launch seed is the same one that
  // prices every family, so both numbers are bigint and the monthly one is for 100 GB.
  expect(typeof r.value.perGbMonthMinor).toBe("bigint");
  expect(typeof r.value.monthlyMinor).toBe("bigint");
  expect(r.value.monthlyMinor!).toBeGreaterThanOrEqual(r.value.perGbMonthMinor);
  expect(r.value.unit).toBe("gb_month");
});

it("a size that is not known gives the per-GB price only", async () => {
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", null, clockAt(T0)));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.monthlyMinor).toBeNull();
});

it("no price row for the market means price unavailable and nothing is sold (R16)", async () => {
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "KE", 10, clockAt(T0)));
  expect(r).toMatchObject({ ok: false, error: "not_found", fields: { price: "unavailable" } });
});

it("a row that is not a plain decimal is not a price", async () => {
  await t.pool.query(
    `update settings set value = '{"usd":"abc","unit":"gb_month"}'::jsonb
      where key = 'config_price.snapshot_gb_month' and market = 'BD'`,
  );
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", 10, clockAt(T0)));
  expect(r).toMatchObject({ ok: false, error: "not_found" });
});

it("an unusable size is refused", async () => {
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", -5, clockAt(T0)));
  expect(r).toMatchObject({ ok: false, error: "validation" });
});

// WPU-M2.
const setRow = (value: string) =>
  t.pool.query(
    `update settings set value = $1::jsonb where key = 'config_price.snapshot_gb_month' and market = 'BD'`,
    [value],
  );

it("a zero price is not a price: nothing is sold (R16)", async () => {
  for (const usd of ["0", "0.00", "0.0000"]) {
    await setRow(`{"usd":"${usd}","unit":"gb_month"}`);
    const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", 10, clockAt(T0)));
    expect(r).toMatchObject({ ok: false, error: "not_found", fields: { price: "unavailable" } });
  }
});

it("the price is read at the instant of the clock, like the rate, the rule and the book", async () => {
  await setRow(
    JSON.stringify({
      v: 1,
      unit: "gb_month",
      entries: [
        { from: "1970-01-01T00:00:00.000Z", usd: "0.05", by: null },
        { from: "2026-11-11T07:00:00.000Z", usd: "0.10", by: null },
      ],
    }),
  );
  const before = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", null, clockAt(T0)));
  const after = await asRole(t, "web_rw", (tx) =>
    snapshotPrice(tx, "BD", null, clockAt("2026-11-11T08:00:00.000Z")),
  );
  expect(before.ok && after.ok).toBe(true);
  if (!before.ok || !after.ok) return;
  expect(after.value.perGbMonthMinor).toBeGreaterThan(before.value.perGbMonthMinor);
});

it("carries the base and the steps of the unit price, adding up to the price", async () => {
  await setRow('{"usd":"0.05","unit":"gb_month"}');
  const r = await asRole(t, "web_rw", (tx) => snapshotPrice(tx, "BD", null, clockAt(T0)));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const b = r.value.breakdown;
  expect(b.totalMinor).toBe(r.value.perGbMonthMinor);
  expect(b.steps.reduce((a, s) => a + s.amountMinor, b.baseMinor)).toBe(b.totalMinor);
  expect(b.steps.map((s) => s.code)).toContain("korea_vat");
});
