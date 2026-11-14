import { expect, it } from "vitest";
import {
  LAUNCH_MARKET,
  PRODUCTION_LAUNCH_MARKET_LIMITS,
  launchSeedInputFor,
  launchSeedSummary,
} from "../seed/launch";

// WPU-X6: what the migrator hands seedLaunchData for the TC_STAGE of the deploy. Pure, no database.
const AT = new Date("2026-11-14T06:00:00.000Z");

it("the production limits are the owner decision of 2026-11-14: 100 to 50,000 BDT, no quick amounts, active", () => {
  expect(PRODUCTION_LAUNCH_MARKET_LIMITS).toEqual({
    topupMinMinor: 10_000n,
    topupMaxMinor: 5_000_000n,
    quickAmounts: [],
    active: true,
  });
  expect(Object.isFrozen(PRODUCTION_LAUNCH_MARKET_LIMITS)).toBe(true);
  expect(Object.isFrozen(PRODUCTION_LAUNCH_MARKET_LIMITS.quickAmounts)).toBe(true);
  // the same values as the staging market, decided for production on their own
  expect(PRODUCTION_LAUNCH_MARKET_LIMITS.topupMinMinor).toBe(LAUNCH_MARKET.topupMinMinor);
  expect(PRODUCTION_LAUNCH_MARKET_LIMITS.topupMaxMinor).toBe(LAUNCH_MARKET.topupMaxMinor);
});

it("TC_STAGE staging seeds the staging data with the staging market", () => {
  expect(launchSeedInputFor("staging", AT)).toEqual({ environment: "staging", at: AT });
});

it("TC_STAGE production seeds production with the decided limits", () => {
  expect(launchSeedInputFor("production", AT)).toEqual({
    environment: "production",
    at: AT,
    market: PRODUCTION_LAUNCH_MARKET_LIMITS,
  });
});

it("a missing or unknown stage is production: never the staging rate or flags that are on (R12, R16)", () => {
  for (const stage of [undefined, "", "prod", "Production", "staging ", "STAGING", "dev-ana"]) {
    expect(launchSeedInputFor(stage, AT), JSON.stringify(stage)).toEqual({
      environment: "production",
      at: AT,
      market: PRODUCTION_LAUNCH_MARKET_LIMITS,
    });
  }
});

it("the summary holds booleans and a count only", () => {
  expect(
    launchSeedSummary({
      market: true,
      fxRate: false,
      pricingRule: true,
      flagsAdded: ["linux_instance", "disk"],
    }),
  ).toEqual({ market: true, fxRate: false, pricingRule: true, flagsAdded: 2 });
});
