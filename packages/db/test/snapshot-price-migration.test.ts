import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { readConfigPrices } from "../seed/config-prices";
import { seedLaunchData } from "../seed/launch";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G9: migration 0014 seeds the default snapshot price (Lightsail USD 0.05 per GB-month), changes
// nothing an admin edited, and the launch seed adds the same row for a market created after it.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole | undefined, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, role === undefined ? {} : { role });
const SQL = readFileSync(
  new URL("../migrations/0014_snapshot_price_default.sql", import.meta.url),
  "utf8",
);

it("inserts the default for an existing market and a second run changes nothing", async () => {
  await ensureMarket(t.pool);
  await t.pool.query("delete from settings where key = 'config_price.snapshot_gb_month'");
  await t.pool.query(SQL);
  await t.pool.query(SQL);
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices["config_price.snapshot_gb_month"]).toEqual({ usd: "0.05", unit: "gb_month" });
  const count = await t.pool.query(
    "select count(*)::int as n from settings where key = 'config_price.snapshot_gb_month'",
  );
  expect(count.rows[0].n).toBe(1);
});

it("a price an admin edited is left alone", async () => {
  await t.pool.query(
    `update settings set value = '{"usd":"0.07","unit":"gb_month"}'::jsonb
      where key = 'config_price.snapshot_gb_month' and market = 'BD'`,
  );
  await t.pool.query(SQL);
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices["config_price.snapshot_gb_month"]).toEqual({ usd: "0.07", unit: "gb_month" });
});

it("the launch seed adds the default where the migration found no market", async () => {
  await t.pool.query("delete from settings where key = 'config_price.snapshot_gb_month'");
  await as(undefined, (tx) =>
    seedLaunchData(tx, { environment: "staging", at: new Date("2026-11-12T06:00:00Z") }),
  );
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices["config_price.snapshot_gb_month"]).toEqual({ usd: "0.05", unit: "gb_month" });
});
