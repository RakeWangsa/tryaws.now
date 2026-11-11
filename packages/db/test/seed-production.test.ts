import { expect, it } from "vitest";
import type { Tx } from "../client";
import { FEATURE_FLAG_KEYS, readFeatureFlags } from "../repositories/config/feature-flags";
import { readFxRateInForce } from "../repositories/config/fx-rates";
import { readPricingRuleInForce } from "../repositories/config/pricing-rules";
import {
  seedEnvironmentFor,
  seedLaunchData,
  type MarketLimits,
  type SeedEnvironment,
} from "../seed/launch";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const owner = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn);
const AT = new Date("2026-11-11T06:00:00.000Z");
const FAR = new Date("2030-01-01T00:00:00.000Z");
// a test value: in production the owner decides these (Needs decision item 4 of Task 14)
const LIMITS: MarketLimits = {
  topupMinMinor: 10_000n,
  topupMaxMinor: 5_000_000n,
  quickAmounts: [],
  active: false,
};
const count = async (table: string) =>
  (await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

it("seedEnvironmentFor: only a stage on the list is staging; every other name is production (fail closed)", () => {
  expect(seedEnvironmentFor("staging", ["staging"])).toBe("staging");
  for (const stage of ["production", "prod", "Production", "live", "", "staging "]) {
    expect(seedEnvironmentFor(stage, ["staging"]), JSON.stringify(stage)).toBe("production");
  }
  expect(seedEnvironmentFor("production", [])).toBe("production");
  expect(seedEnvironmentFor("dev-ana", ["staging", "dev-ana"])).toBe("staging");
});

// The first test of the file: nothing has been seeded yet.
it("an environment other than staging and production is refused before anything is written (R16)", async () => {
  for (const environment of ["prod", "", "STAGING"]) {
    await expect(
      owner((tx) => seedLaunchData(tx, { environment: environment as SeedEnvironment, at: AT })),
    ).rejects.toThrow(new TypeError("seedLaunchData: environment must be staging or production"));
  }
  expect(await count("markets")).toBe(0);
});

it("the production seed without the limits of the market writes nothing at all: nothing is guessed (R16)", async () => {
  const result = await owner((tx) => seedLaunchData(tx, { environment: "production", at: AT }));
  expect(result).toEqual({ market: false, fxRate: false, pricingRule: false, flagsAdded: [] });
  for (const table of ["markets", "fx_rates", "pricing_rules", "feature_flags"])
    expect(await count(table), table).toBe(0);
});

it("the production seed adds the market with the given limits, the rule and twelve flags that are all off, and no rate (R12, R16)", async () => {
  const result = await owner((tx) =>
    seedLaunchData(tx, { environment: "production", at: AT, market: LIMITS }),
  );
  expect(result).toEqual({
    market: true,
    fxRate: false,
    pricingRule: true,
    flagsAdded: [...FEATURE_FLAG_KEYS],
  });
  expect(
    (await t.pool.query("select active, topup_min_minor::text as min from markets")).rows[0],
  ).toEqual({ active: false, min: "10000" });
  const flags = await owner((tx) => readFeatureFlags(tx, "BD"));
  expect(flags).toHaveLength(12);
  expect(flags.filter((f) => f.enabled)).toEqual([]);
  expect(await owner((tx) => readFxRateInForce(tx, "BD", FAR))).toBeNull(); // no price until a finance admin sets one
  expect(await owner((tx) => readPricingRuleInForce(tx, "BD", null, AT))).not.toBeNull();
});

it("running the production seed again keeps a flag that was switched on and adds no rate", async () => {
  await t.pool.query("update feature_flags set enabled = true where key = 'linux_instance'");
  const again = await owner((tx) =>
    seedLaunchData(tx, { environment: "production", at: FAR, market: LIMITS }),
  );
  expect(again).toEqual({ market: false, fxRate: false, pricingRule: false, flagsAdded: [] });
  expect((await owner((tx) => readFeatureFlags(tx, "BD"))).filter((f) => f.enabled)).toEqual([
    { key: "linux_instance", enabled: true },
  ]);
  expect((await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n).toBe(0);
});
