import { uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit } from "../test/orders-kit";
import { createDraft } from "./draft";

// WPU-G10. A DNS zone is priced from the config price in force at the instant of the order: a dated
// entry that has not started is not used, one that has started replaces the earlier price, and a stored
// value that does not parse sells nothing (R16). The draft carries the quote that the customer sees.
const t = useTempDatabase();

async function kitWith(value: unknown | null) {
  const kit = await makeKit(t);
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'dns_zone', 'BD', true)
     on conflict (key, market) do update set enabled = true`,
  );
  await t.pool.query(
    "delete from settings where key = 'config_price.dns_zone_month' and market = 'BD'",
  );
  if (value !== null) {
    await t.pool.query(
      `insert into settings (id, key, market, scope, scope_id, value)
       values (gen_random_uuid(), 'config_price.dns_zone_month', 'BD', 'market', null, $1::jsonb)`,
      [JSON.stringify(value)],
    );
  }
  return kit;
}
const name = () => `zone${uniqueSuffix().replace(/[^a-z0-9]/g, "")}.example`;
const ask = async (kit: Awaited<ReturnType<typeof kitWith>>) =>
  createDraft(kit.deps, kit.session, {
    family: "dns_zone",
    config: { zoneName: name(), declaredControl: true },
  });
const dated = (...entries: [string, string][]) => ({
  v: 1,
  unit: "month",
  entries: entries.map(([from, usd]) => ({ from, usd, by: null })),
});

describe("the DNS zone price follows the dated config price", () => {
  it("a price that has started is used, and the next one is not used before its start", async () => {
    const kit = await kitWith(
      dated(["2026-01-01T00:00:00.000Z", "0.50"], ["2999-01-01T00:00:00.000Z", "5"]),
    );
    const cheap = await ask(kit);
    if (!cheap.ok) throw new Error(`refused: ${cheap.error}`);
    expect(cheap.value.quote.totalMinor).toBeGreaterThan(0n);
    await kitWith(dated(["2026-01-01T00:00:00.000Z", "5"]));
    const dear = await ask(kit);
    if (!dear.ok) throw new Error(`refused: ${dear.error}`);
    expect(dear.value.quote.totalMinor).toBeGreaterThan(cheap.value.quote.totalMinor);
  });

  it("the legacy value of the seed still prices a zone", async () => {
    const kit = await kitWith({ usd: "0.50", unit: "month" });
    expect((await ask(kit)).ok).toBe(true);
  });

  it("no entry has started yet: nothing is sold (R16)", async () => {
    const kit = await kitWith(dated(["2999-01-01T00:00:00.000Z", "0.50"]));
    expect(await ask(kit)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { price: "unavailable" },
    });
  });

  it("a stored value that does not parse sells nothing (R16)", async () => {
    const kit = await kitWith({ v: 7, entries: "x" });
    expect(await ask(kit)).toMatchObject({ ok: false, fields: { price: "unavailable" } });
  });
});
