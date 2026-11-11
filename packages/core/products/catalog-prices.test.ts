import { readFileSync } from "node:fs";
import type { FxRateRow } from "@tc/db";
import { describe, expect, it } from "vitest";
import { LAUNCH_PRICING_STEPS } from "@tc/db";
import { quote, type PricingRule } from "../pricing/index";
import type { PricingInForce } from "../rates/in-force";
import { priceRows, type CatalogRowForPricing } from "./catalog-prices";

const rule: PricingRule = { version: "launch", steps: [...LAUNCH_PRICING_STEPS] };
const inForce = (rate = "127"): PricingInForce => ({
  pricedAt: new Date("2026-11-11T06:00:00Z"),
  fx: {
    id: "fx1",
    market: "BD",
    rate,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  } as FxRateRow,
  rule: {
    id: "rule1",
    productFamily: null,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    value: { ...rule, version: "rule1" },
  },
});
const row = (over: Partial<CatalogRowForPricing> = {}): CatalogRowForPricing => ({
  id: "00000000-0000-4000-8000-000000000001",
  family: "linux_instance",
  awsId: "nano_3_0",
  platform: "linux",
  region: "ap-southeast-1",
  specs: { vcpus: 2 },
  awsPriceUsd: "5.0000",
  billingUnit: "month",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});

describe("priceRows", () => {
  it("prices a row exactly as the engine does with the same inputs", () => {
    const found = inForce();
    const out = priceRows([row()], new Map([["linux_instance", found]]), {})!;
    expect(out).toHaveLength(1);
    expect(out[0]!.priceBdt).toEqual(
      quote({ awsPriceUsd: "5.0000", fxRate: found.fx.rate, rule: found.rule.value }),
    );
    expect(typeof out[0]!.priceBdt.totalMinor).toBe("bigint");
  });

  it("leaves an inactive row out unless the caller asks for it", () => {
    const map = new Map([["linux_instance", inForce()]]);
    const rows = [row(), row({ id: "00000000-0000-4000-8000-000000000002", active: false })];
    expect(priceRows(rows, map, {})).toHaveLength(1);
    expect(priceRows(rows, map, { includeInactive: true })).toHaveLength(2);
  });

  it("returns null when a family has no rate and rule in force (R16)", () => {
    expect(priceRows([row()], new Map(), {})).toBeNull();
  });

  it("keeps id, family, region, platform, specs and the USD text", () => {
    const out = priceRows([row()], new Map([["linux_instance", inForce()]]), {});
    expect(out![0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      family: "linux_instance",
      region: "ap-southeast-1",
      platform: "linux",
      awsPriceUsd: "5.0000",
    });
  });

  it("the source has no float step on a price", () => {
    const src = readFileSync(new URL("./catalog-prices.ts", import.meta.url), "utf8");
    for (const banned of ["Number(", "parseFloat", "toFixed", "Math.round"]) {
      expect(src.includes(banned)).toBe(false);
    }
  });
});
