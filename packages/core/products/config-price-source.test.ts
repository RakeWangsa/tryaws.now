import { describe, expect, it } from "vitest";
import { withConfigPrice } from "./config-price-source";
import type { ResolvedProduct } from "./instance";

// WPA-P2. The price source of a family that has a catalog row AND an editable config price: the config
// row wins when the market has a usable one, the catalog row stays when it has none, and a row that
// exists but cannot be a price sells nothing (R16). Text all the way to the engine (R4).
const base: ResolvedProduct = {
  family: "disk",
  productId: "p",
  region: "ap-south-1",
  featureFlag: "disk",
  awsPriceUsd: "0.1000",
  quantity: "100",
  facts: { bundleUsd: "0.1000", windows: false, staticIps: 0 },
  needs: [],
  resourceConfig: {},
};

describe("withConfigPrice", () => {
  it("no config row: the catalog row stays authoritative and the object is the same", () => {
    const r = withConfigPrice(base, undefined, "gb_month");
    expect(r).toEqual({ ok: true, value: base });
  });

  it("a usable config row replaces the price and the bundle price of the facts, nothing else", () => {
    const r = withConfigPrice(base, { usd: "0.12", unit: "gb_month" }, "gb_month");
    expect(r).toEqual({
      ok: true,
      value: { ...base, awsPriceUsd: "0.12", facts: { ...base.facts, bundleUsd: "0.12" } },
    });
  });

  it("a row of another unit is not a price (R16)", () => {
    expect(withConfigPrice(base, { usd: "0.12", unit: "month" }, "gb_month")).toEqual({
      ok: false,
      error: "validation",
      fields: { price: "unavailable" },
    });
  });

  it.each(["0", "0.00", "-1", "1e3", "abc", "", " 1"])(
    "the value %j is not a price (R16)",
    (usd) => {
      expect(withConfigPrice(base, { usd, unit: "gb_month" }, "gb_month")).toMatchObject({
        ok: false,
        fields: { price: "unavailable" },
      });
    },
  );
});
