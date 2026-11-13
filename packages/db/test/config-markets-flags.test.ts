import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  FEATURE_FLAG_KEYS,
  isFeatureFlagKey,
  readFeatureFlag,
  readFeatureFlags,
} from "../repositories/config/feature-flags";
import {
  readMarket,
  readMarketBasics,
  readMarketCodes,
  readMarkets,
} from "../repositories/config/markets";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

// The first test of the file: nothing below has inserted a row yet (R12).
it("a freshly migrated database holds no market, rate, rule or flag, so no migration switches anything on", async () => {
  for (const table of ["markets", "fx_rates", "pricing_rules", "feature_flags"]) {
    const { rows } = await t.pool.query(`select count(*)::int as n from ${table}`);
    expect(rows[0].n, table).toBe(0);
  }
});

it("the twelve flag keys are the families of section 10.3, once each", () => {
  expect([...FEATURE_FLAG_KEYS]).toEqual([
    "linux_instance",
    "static_ip",
    "backup",
    "disk",
    "windows_instance",
    "database",
    "load_balancer",
    "bucket",
    "container_service",
    "cdn",
    "dns_zone",
    "domain",
  ]);
  expect(new Set(FEATURE_FLAG_KEYS).size).toBe(12);
  expect(isFeatureFlagKey("cdn")).toBe(true);
  for (const bad of ["CDN", "toaster", "", null, undefined, 3])
    expect(isFeatureFlagKey(bad)).toBe(false);
});

it("readMarket gives the whole row to web_rw and admin_rw, and null for a code it does not know", async () => {
  await ensureMarket(t.pool, "BD");
  await ensureMarket(t.pool, "KE");
  const expected = {
    code: "BD",
    currency: "BDT",
    gateway: "eps",
    locales: ["bn", "en"],
    numerals: "beng",
    topupMinMinor: 10000n,
    topupMaxMinor: 5000000n,
    quickAmounts: [],
    active: false,
  };
  for (const role of ["web_rw", "admin_rw"] as const)
    expect(await as(role, (tx) => readMarket(tx, "BD")), role).toEqual(expected);
  expect(await as("web_rw", (tx) => readMarket(tx, "ZZ"))).toBeNull();
  expect(await as("web_rw", (tx) => readMarket(tx, "bd"))).toBeNull();
  expect((await as("web_rw", (tx) => readMarkets(tx))).map((m) => m.code)).toEqual(["BD", "KE"]);
});

it("worker_rw reads only the four columns of readMarketBasics; the whole row is refused", async () => {
  expect(await as("worker_rw", (tx) => readMarketBasics(tx, "BD"))).toEqual({
    code: "BD",
    currency: "BDT",
    locales: ["bn", "en"],
    numerals: "beng",
  });
  await expect(as("worker_rw", (tx) => readMarket(tx, "BD"))).rejects.toMatchObject({
    name: "DbError",
    code: "42501",
  });
  expect(await as("worker_rw", (tx) => readMarketBasics(tx, "ZZ"))).toBeNull();
});

it("a flag is true, false, or null when no row exists; a bad key or market is null without a query", async () => {
  await insertRow(t.pool, "feature_flags", { key: "linux_instance", market: "BD", enabled: true });
  await insertRow(t.pool, "feature_flags", { key: "cdn", market: "BD", enabled: false });
  await insertRow(t.pool, "feature_flags", { key: "linux_instance", market: "KE", enabled: false });
  for (const role of ["web_rw", "admin_rw"] as const) {
    expect(await as(role, (tx) => readFeatureFlag(tx, "linux_instance", "BD")), role).toBe(true);
    expect(await as(role, (tx) => readFeatureFlag(tx, "cdn", "BD")), role).toBe(false);
    expect(await as(role, (tx) => readFeatureFlag(tx, "domain", "BD")), role).toBeNull();
  }
  expect(await as("web_rw", (tx) => readFeatureFlag(tx, "linux_instance", "KE"))).toBe(false);
  expect(await as("web_rw", (tx) => readFeatureFlag(tx, "Linux Instance", "BD"))).toBeNull();
  expect(await as("web_rw", (tx) => readFeatureFlag(tx, "linux_instance", "bd"))).toBeNull();
});

it("readFeatureFlags lists the rows of one market by key", async () => {
  expect(await as("admin_rw", (tx) => readFeatureFlags(tx, "BD"))).toEqual([
    { key: "cdn", enabled: false },
    { key: "linux_instance", enabled: true },
  ]);
  expect(await as("admin_rw", (tx) => readFeatureFlags(tx, "bd"))).toEqual([]);
});

it("worker_rw and report_ro have no grant on feature_flags: the read fails with a DbError and never answers", async () => {
  await expect(
    as("worker_rw", (tx) => readFeatureFlag(tx, "linux_instance", "BD")),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
  await expect(as("report_ro", (tx) => readFeatureFlags(tx, "BD"))).rejects.toMatchObject({
    name: "DbError",
    code: "42501",
  });
});

// The exchange-rate watch (WPU-Y1) runs as worker_rw, which may read only code, currency, locales and numerals of
// markets (0006). readMarkets selects the whole row and is refused for it; readMarketCodes must work.
it("worker_rw can list the market codes, and readMarkets (the whole row) is refused for it", async () => {
  await ensureMarket(t.pool, "BD");
  expect(await as("worker_rw", (tx) => readMarketCodes(tx))).toContain("BD");
  await expect(as("worker_rw", (tx) => readMarkets(tx))).rejects.toThrow();
});
