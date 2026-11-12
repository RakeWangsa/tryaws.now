import { LAUNCH_PRICING_STEPS, seedLaunchData } from "@tc/db";
import { uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { quoteWithBook } from "../pricing/index";
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
// WPU-D3. The DNS zone is priced through the price book of its family (WPA-P1): base USD 0.50 per zone
// per month (the seed), and the owner's default margin of 15 percent as a dated entry of
// price_book.dns_zone. The figures below are computed with the pure engine from the same rule and the
// rate 127; the order path must give the same paisa.
describe("the DNS zone price follows the price book of the family dns_zone (WPU-D3)", () => {
  const rule = {
    version: "wpu-d3",
    steps: LAUNCH_PRICING_STEPS.map((s) => ({ ...s, label: { ...s.label } })),
  };
  const engine = (margin: string | null) =>
    quoteWithBook(
      { awsPriceUsd: "0.50", fxRate: "127", rule },
      margin === null ? null : { margin: { kind: "percent", value: margin }, commission: null },
    ).quote.totalMinor;

  async function priced(book: "seed" | "none" | "edited") {
    const kit = await kitWith({ usd: "0.50", unit: "month" });
    await t.pool.query("delete from settings where key = 'price_book.dns_zone' and market = 'BD'");
    if (book === "edited") {
      await t.pool.query(
        `insert into settings (id, key, market, scope, scope_id, value)
         values (gen_random_uuid(), 'price_book.dns_zone', 'BD', 'market', null, $1::jsonb)`,
        [
          JSON.stringify({
            v: 1,
            entries: [
              {
                from: "2026-01-01T00:00:00.000Z",
                margin: { kind: "percent", value: "0.30" },
                commission: null,
                by: null,
              },
            ],
          }),
        ],
      );
    }
    if (book === "seed") {
      await t.db.transaction((tx) =>
        seedLaunchData(tx, {
          environment: "staging",
          at: new Date("2026-11-11T06:00:00.000Z"),
        }),
      );
    }
    const draft = await ask(kit);
    if (!draft.ok) throw new Error(`refused: ${draft.error}`);
    return draft.value.quote.totalMinor;
  }

  it("the seeded book is a 15 percent margin from the seed time; the quote equals the engine's", async () => {
    const total = await priced("seed");
    expect(total).toBe(engine("0.15"));
    expect(total).toBeGreaterThan(engine(null));
    const stored = await t.pool.query(
      "select value from settings where key = 'price_book.dns_zone' and market = 'BD'",
    );
    expect(stored.rows[0].value).toEqual({
      v: 1,
      entries: [
        {
          from: "2026-11-11T06:00:00.000Z",
          margin: { kind: "percent", value: "0.15" },
          commission: null,
          by: null,
        },
      ],
    });
  });

  it("with no book row the price is the base only: the rule alone, no margin", async () => {
    expect(await priced("none")).toBe(engine(null));
  });

  it("an edited book is used and the seed does not overwrite it", async () => {
    expect(await priced("edited")).toBe(engine("0.30"));
    await t.db.transaction((tx) =>
      seedLaunchData(tx, {
        environment: "staging",
        at: new Date("2026-11-12T06:00:00.000Z"),
      }),
    );
    const stored = await t.pool.query(
      "select value from settings where key = 'price_book.dns_zone' and market = 'BD'",
    );
    expect(stored.rows[0].value.entries[0].margin.value).toBe("0.30");
  });

  it("an edited base price is not overwritten by the seed or the migration", async () => {
    await kitWith({ usd: "0.75", unit: "month" });
    await t.db.transaction((tx) =>
      seedLaunchData(tx, {
        environment: "staging",
        at: new Date("2026-11-12T06:00:00.000Z"),
      }),
    );
    const stored = await t.pool.query(
      "select value from settings where key = 'config_price.dns_zone_month' and market = 'BD'",
    );
    expect(stored.rows[0].value.usd).toBe("0.75");
  });

  it("the dns_zone flag is off by default in production seeds (R12)", async () => {
    const flags = await t.pool.query(
      "select enabled from feature_flags where key = 'dns_zone' and market = 'BD'",
    );
    // the kit turned it on for the order tests; a production seed never does
    await t.pool.query("delete from feature_flags where key = 'dns_zone' and market = 'BD'");
    await t.db.transaction((tx) =>
      seedLaunchData(tx, {
        environment: "production",
        at: new Date("2026-11-12T06:00:00.000Z"),
      }),
    );
    const after = await t.pool.query(
      "select enabled from feature_flags where key = 'dns_zone' and market = 'BD'",
    );
    expect(flags.rows.length).toBeGreaterThanOrEqual(0);
    expect(after.rows).toEqual([{ enabled: false }]);
  });
});
