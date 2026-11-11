import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  CONFIG_PRICE_KEYS,
  STAGING_CONFIG_PRICES,
  readConfigPrices,
  seedConfigPrices,
  type ConfigPriceKey,
} from "../seed/config-prices";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// Needs the local PostgreSQL (pnpm db:up). The seed runs as the table owner, the read as worker_rw.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole | undefined, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, role === undefined ? {} : { role });
const AT = new Date("2026-11-11T06:00:00Z");
const FOUR = [
  { key: "config_price.block_storage_gb_month", usd: "0.10", unit: "gb_month" },
  { key: "config_price.snapshot_gb_month", usd: "0.05", unit: "gb_month" },
  { key: "config_price.load_balancer_month", usd: "18", unit: "month" },
  { key: "config_price.dns_zone_month", usd: "0.50", unit: "month" },
] as const;

it("adds the four keys, a second run adds none", async () => {
  await ensureMarket(t.pool);
  const first = await as(undefined, (tx) =>
    seedConfigPrices(tx, { market: "BD", at: AT, prices: FOUR }),
  );
  expect([...first.added].sort()).toEqual([...CONFIG_PRICE_KEYS].sort());
  const second = await as(undefined, (tx) =>
    seedConfigPrices(tx, { market: "BD", at: AT, prices: FOUR }),
  );
  expect(second.added).toEqual([]);
});

it("a value an admin edited is left alone by a later seed", async () => {
  await t.pool.query(
    `update settings set value = '{"usd":"0.20","unit":"gb_month"}'::jsonb
      where key = 'config_price.block_storage_gb_month' and market = 'BD'`,
  );
  await as(undefined, (tx) => seedConfigPrices(tx, { market: "BD", at: AT, prices: FOUR }));
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices["config_price.block_storage_gb_month"]).toEqual({ usd: "0.20", unit: "gb_month" });
  expect(prices["config_price.load_balancer_month"]).toEqual({ usd: "18", unit: "month" });
});

it("a row that is not { usd: plain decimal, unit: known } is not a price", async () => {
  await t.pool.query("delete from settings where key = 'config_price.snapshot_gb_month'");
  await insertRow(t.pool, "settings", {
    key: "config_price.snapshot_gb_month",
    market: "BD",
    scope: "market",
    value: JSON.stringify({ usd: 5 }),
  });
  await t.pool.query(
    `update settings set value = '{}'::jsonb where key = 'config_price.dns_zone_month' and market = 'BD'`,
  );
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices["config_price.snapshot_gb_month"]).toBeUndefined();
  expect(prices["config_price.dns_zone_month"]).toBeUndefined();
});

it("a market with no rows has no price for any key, and the staging default holds two keys", async () => {
  await ensureMarket(t.pool, "KE");
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "KE"));
  for (const key of CONFIG_PRICE_KEYS as readonly ConfigPriceKey[]) {
    expect(prices[key]).toBeUndefined();
  }
  expect(STAGING_CONFIG_PRICES.map((p) => p.key)).toEqual([
    "config_price.block_storage_gb_month",
    "config_price.snapshot_gb_month",
  ]);
});
