import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  FEATURE_FLAG_KEYS,
  readFeatureFlag,
  readFeatureFlags,
} from "../repositories/config/feature-flags";
import { readFxRateInForce } from "../repositories/config/fx-rates";
import { readMarket } from "../repositories/config/markets";
import { readPricingRuleInForce } from "../repositories/config/pricing-rules";
import { LAUNCH_PRICING_STEPS, seedLaunchData, STAGING_FLAGS_ON } from "../seed/launch";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const owner = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn);
const AT = new Date("2026-11-11T06:00:00.000Z");

it("the staging seed adds the market, the rate 127, the launch rule and twelve flags, the core four on", async () => {
  const result = await owner((tx) => seedLaunchData(tx, { environment: "staging", at: AT }));
  expect(result).toEqual({
    market: true,
    fxRate: true,
    pricingRule: true,
    flagsAdded: [...FEATURE_FLAG_KEYS],
  });
  expect(await owner((tx) => readMarket(tx, "BD"))).toMatchObject({
    code: "BD",
    currency: "BDT",
    gateway: "eps",
    numerals: "beng",
    active: true,
  });
  expect((await owner((tx) => readFxRateInForce(tx, "BD", AT)))?.rate).toBe("127");
  expect(await owner((tx) => readFxRateInForce(tx, "BD", new Date(AT.getTime() - 1)))).toBeNull();
  const rule = await owner((tx) => readPricingRuleInForce(tx, "BD", "linux_instance", AT));
  expect(rule?.productFamily).toBeNull();
  expect(rule?.steps).toEqual(LAUNCH_PRICING_STEPS);
  const flags = await owner((tx) => readFeatureFlags(tx, "BD"));
  expect(flags).toHaveLength(12);
  expect(
    flags
      .filter((f) => f.enabled)
      .map((f) => f.key)
      .sort(),
  ).toEqual([...STAGING_FLAGS_ON].sort());
  expect(STAGING_FLAGS_ON).toEqual(["linux_instance", "static_ip", "backup", "disk"]);
});

it("a second run adds nothing and changes nothing, whatever its instant", async () => {
  await t.pool.query("update feature_flags set enabled = true where key = 'cdn'");
  const again = await owner((tx) =>
    seedLaunchData(tx, { environment: "staging", at: new Date("2026-12-24T00:00:00Z") }),
  );
  expect(again).toEqual({ market: false, fxRate: false, pricingRule: false, flagsAdded: [] });
  for (const [table, n] of [
    ["markets", 1],
    ["fx_rates", 1],
    ["pricing_rules", 1],
    ["feature_flags", 12],
  ] as const) {
    expect((await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(
      n,
    );
  }
  expect(await owner((tx) => readFeatureFlag(tx, "cdn", "BD"))).toBe(true); // an admin's choice survives
});

it("an instant that is not a valid date is refused before anything is written", async () => {
  await expect(
    owner((tx) => seedLaunchData(tx, { environment: "staging", at: new Date("nope") })),
  ).rejects.toThrow(new TypeError("seedLaunchData: at: not a valid date"));
});
