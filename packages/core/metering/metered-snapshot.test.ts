import { describe, expect, it } from "vitest";
import { quote } from "../pricing/quote";
import type { MeteredUnitPrice } from "../pricing/metering";
import { dailyMeteredChargeMinor } from "../pricing/metering";
import type { PricingRule } from "../pricing/types";
import { meteredSnapshot } from "./run";

// WPU-Y2: a metered charge saves the inputs of its unit price, the usage and its own split.
const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
  ],
};
const unitQuote = quote({ awsPriceUsd: "0.05", fxRate: "127", rule: RULE });
const unit: MeteredUnitPrice = {
  totalMinor: unitQuote.totalMinor,
  baseMinor: unitQuote.baseMinor,
  steps: unitQuote.steps,
  charge: {
    pricedAt: new Date("2026-11-11T08:00:00.000Z"),
    awsPriceUsd: "0.05",
    quantity: "1",
    fx: { id: "fx-1", rate: "127", effectiveFrom: new Date("2026-11-10T00:00:00.000Z") },
    rule: { id: "rule-id-1", version: "rule-1" },
    book: null,
    quote: unitQuote,
  },
};

describe("meteredSnapshot", () => {
  it("splits the daily charge like the postings and its total is the charge", () => {
    const charge = dailyMeteredChargeMinor("10", unit.totalMinor);
    const { priceSnapshot } = meteredSnapshot(unit, "snapshot_gb", "10", charge);
    expect(priceSnapshot).toBeDefined();
    expect(priceSnapshot?.kind).toBe("metered");
    expect(priceSnapshot?.totalMinor).toBe(charge.toString());
    expect(priceSnapshot?.meter).toEqual({
      metric: "snapshot_gb",
      usage: "10",
      unitTotalMinor: unit.totalMinor.toString(),
    });
    expect(priceSnapshot?.awsPriceUsd).toBe("0.05");
    expect(priceSnapshot?.fx.id).toBe("fx-1");
  });

  it("saves nothing for a unit without inputs (no recalculation is invented)", () => {
    const bare: MeteredUnitPrice = {
      totalMinor: unit.totalMinor,
      baseMinor: unit.baseMinor,
      steps: unit.steps,
    };
    expect(meteredSnapshot(bare, "snapshot_gb", "10", 5n)).toEqual({});
  });
});
