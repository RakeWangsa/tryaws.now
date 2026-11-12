import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { readConfigPrices } from "../seed/config-prices";
import { seedLaunchData } from "../seed/launch";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-M1: migration 0015 seeds the default price of an unattached static IP (Lightsail USD 0.005 per
// hour), changes nothing an admin edited, and the launch seed adds the same row for a market created
// after it.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole | undefined, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, role === undefined ? {} : { role });
const SQL = readFileSync(
  new URL("../migrations/0015_static_ip_unattached_price.sql", import.meta.url),
  "utf8",
);
const KEY = "config_price.static_ip_unattached_hour";

it("inserts the default for an existing market and a second run changes nothing", async () => {
  await ensureMarket(t.pool);
  await t.pool.query("delete from settings where key = $1", [KEY]);
  await t.pool.query(SQL);
  await t.pool.query(SQL);
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices[KEY]).toEqual({ usd: "0.005", unit: "hour" });
  const count = await t.pool.query("select count(*)::int as n from settings where key = $1", [KEY]);
  expect(count.rows[0].n).toBe(1);
});

it("a price an admin edited is left alone", async () => {
  await t.pool.query(
    `update settings set value = '{"usd":"0.007","unit":"hour"}'::jsonb where key = $1 and market = 'BD'`,
    [KEY],
  );
  await t.pool.query(SQL);
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices[KEY]).toEqual({ usd: "0.007", unit: "hour" });
});

it("the launch seed adds the default where the migration found no market", async () => {
  await t.pool.query("delete from settings where key = $1", [KEY]);
  await as(undefined, (tx) =>
    seedLaunchData(tx, { environment: "staging", at: new Date("2026-11-12T06:00:00Z") }),
  );
  const prices = await as("worker_rw", (tx) => readConfigPrices(tx, "BD"));
  expect(prices[KEY]).toEqual({ usd: "0.005", unit: "hour" });
});
