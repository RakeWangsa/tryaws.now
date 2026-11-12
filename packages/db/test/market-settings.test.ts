import { beforeEach, expect, it } from "vitest";
import type { Tx } from "../client";
import { readMarketSettingNumber } from "../repositories/config/market-settings";
import { runTransaction } from "../tx";
import { ensureMarket } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const KEY = "otp.sms_daily_cap";
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });
const asWorker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const put = (value: unknown) =>
  t.pool.query(
    "insert into settings (id, key, market, scope, scope_id, value) values (gen_random_uuid(), $1, 'BD', 'market', null, $2::jsonb)",
    [KEY, JSON.stringify(value)],
  );

beforeEach(async () => {
  await ensureMarket(t.pool);
  await t.pool.query("delete from settings where key = $1", [KEY]);
});

it("reads a whole number as web_rw and as worker_rw (WPU-B6)", async () => {
  await put(7);
  expect(await asWeb((tx) => readMarketSettingNumber(tx, "BD", KEY))).toBe(7);
  expect(await asWorker((tx) => readMarketSettingNumber(tx, "BD", KEY))).toBe(7);
});

it("reads a number written as text", async () => {
  await put("12");
  expect(await asWeb((tx) => readMarketSettingNumber(tx, "BD", KEY))).toBe(12);
});

it("a missing row, a bad market and a bad value are null, so the caller keeps its default (R16)", async () => {
  expect(await asWeb((tx) => readMarketSettingNumber(tx, "BD", KEY))).toBeNull();
  expect(await asWeb((tx) => readMarketSettingNumber(tx, "bd", KEY))).toBeNull();
  for (const bad of [0, -3, 1.5, "abc", "0", "-5", null, {}, 2_000_000]) {
    await t.pool.query("delete from settings where key = $1", [KEY]);
    await put(bad);
    expect(await asWeb((tx) => readMarketSettingNumber(tx, "BD", KEY))).toBeNull();
  }
});
