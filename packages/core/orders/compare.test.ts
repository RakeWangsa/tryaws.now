import { describe, expect, it } from "vitest";
import {
  parseSnapshot,
  quote,
  toSnapshot,
  type PriceSnapshot,
  type PricingRule,
} from "../pricing/index";
import { comparePrice, type PriceDifference } from "./compare";

const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "markup", rate: "0.20", base: "aws", label },
  ],
};

function base(): PriceSnapshot {
  const q = quote({ awsPriceUsd: "3.50", fxRate: "122.5", rule: RULE });
  return toSnapshot(q, { awsPriceUsd: "3.50", pricedAt: new Date("2026-11-11T10:00:00.000Z") });
}

/** A copy of the base with fields replaced, kept consistent (total = base + steps) when asked. */
function variant(over: Partial<PriceSnapshot>): PriceSnapshot {
  return { ...base(), ...over };
}

describe("comparePrice", () => {
  it("treats equal snapshots with different pricedAt as the same", () => {
    const fresh = variant({ pricedAt: "2026-11-11T10:25:00.000Z" });
    expect(comparePrice(base(), fresh)).toEqual({ same: true });
  });

  const b = base();
  const bump = (text: string, by: number) => (BigInt(text) + BigInt(by)).toString();
  const cases: [PriceDifference[], Partial<PriceSnapshot>][] = [
    [["fx_rate"], { fxRate: "123.5" }],
    [["rule_version"], { ruleVersion: "rule-2" }],
    [["aws_price"], { awsPriceUsd: "3.60" }],
    [["quantity"], { quantity: "2" }],
    [["base"], { baseMinor: bump(b.baseMinor, 1) }],
    [
      ["steps"],
      {
        steps: b.steps.map((s, i) => (i === 0 ? { ...s, amountMinor: bump(s.amountMinor, 1) } : s)),
      },
    ],
    [["total"], { totalMinor: bump(b.totalMinor, 1) }],
  ];
  it.each(cases)("reports exactly %j", (expected, over) => {
    const result = comparePrice(base(), variant(over));
    expect(result).toEqual({ same: false, differences: expected });
  });

  it("reports every difference at once, in a fixed order", () => {
    const fresh = variant({ fxRate: "123.5", ruleVersion: "rule-2", totalMinor: "1" });
    expect(comparePrice(base(), fresh)).toEqual({
      same: false,
      differences: ["fx_rate", "rule_version", "total"],
    });
  });

  it("is steps for a reordered list", () => {
    const reversed = [...base().steps].reverse();
    expect(comparePrice(base(), variant({ steps: reversed }))).toEqual({
      same: false,
      differences: ["steps"],
    });
  });

  it("is steps for a different step count", () => {
    expect(comparePrice(base(), variant({ steps: base().steps.slice(0, 1) }))).toEqual({
      same: false,
      differences: ["steps"],
    });
  });

  it("compares amounts as numbers, not as text", () => {
    // The snapshot parser refuses "01", so a text difference cannot hide an equal amount.
    expect(() => parseSnapshot({ ...base(), baseMinor: "01" })).toThrow();
  });
});
