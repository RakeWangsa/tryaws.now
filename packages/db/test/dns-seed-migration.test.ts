import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parsePriceBookValue } from "../repositories/config/price-book";
import { ensureMarket } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-D3, migration 0020. A fresh database has no market when the migrations run, so the seed statements
// are replayed here, after the market exists: they add the base price and the 15 percent book of the DNS
// zone once, and never overwrite an edited value.

const t = useTempDatabase();
const FILE = join(import.meta.dirname, "../migrations/0020_dns_zone_price_and_kyc_open_index.sql");
const seedStatements = () =>
  readFileSync(FILE, "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => /INSERT INTO settings/.test(s))
    .map((s) => s.trim());

const valueOf = async (key: string) =>
  (await t.pool.query("select value from settings where key = $1 and market = 'BD'", [key])).rows[0]
    ?.value;

it("inserts config_price.dns_zone_month = USD 0.50 per month and a dated 15 percent book for BD", async () => {
  await ensureMarket(t.pool, "BD");
  const statements = seedStatements();
  expect(statements).toHaveLength(2);
  for (const sql of statements) await t.pool.query(sql);
  expect(await valueOf("config_price.dns_zone_month")).toEqual({ usd: "0.50", unit: "month" });
  const book = await valueOf("price_book.dns_zone");
  const entries = parsePriceBookValue(book);
  expect(entries).toHaveLength(1);
  expect(entries?.[0]).toMatchObject({
    margin: { kind: "percent", value: "0.15" },
    commission: null,
    by: null,
  });
});

it("never overwrites an edited price or an edited book", async () => {
  await t.pool.query(
    'update settings set value = \'{"usd":"0.80","unit":"month"}\'::jsonb where key = \'config_price.dns_zone_month\' and market = \'BD\'',
  );
  await t.pool.query(
    `update settings set value = '{"v":1,"entries":[{"from":"2026-01-01T00:00:00.000Z","margin":{"kind":"percent","value":"0.30"},"commission":null,"by":null}]}'::jsonb
      where key = 'price_book.dns_zone' and market = 'BD'`,
  );
  for (const sql of seedStatements()) await t.pool.query(sql);
  expect(await valueOf("config_price.dns_zone_month")).toEqual({ usd: "0.80", unit: "month" });
  const entries = parsePriceBookValue(await valueOf("price_book.dns_zone"));
  expect(entries?.[0]?.margin.value).toBe("0.30");
});

it("does not turn the dns_zone flag on (R12)", async () => {
  const { rows } = await t.pool.query(
    "select enabled from feature_flags where key = 'dns_zone' and market = 'BD'",
  );
  expect(rows.every((r) => r.enabled === false)).toBe(true);
});
