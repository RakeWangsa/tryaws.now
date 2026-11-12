import { describe, expect, it } from "vitest";
import { PricingInputError } from "./errors";
import { allowanceLevel, dailyMeteredChargeMinor, splitMeteredChargeMinor } from "./metering";

describe("dailyMeteredChargeMinor: GB x price per GB-month / 30, half-up, paisa", () => {
  it.each([
    // gb, price (paisa per GB-month), expected
    ["30", 100n, 100n], // 30 x 100 / 30
    ["10", 300n, 100n], // 10 x 300 / 30
    ["1", 100n, 3n], // 3.33 -> 3
    ["1", 105n, 4n], // 3.5 -> 4 (half-up)
    ["1", 104n, 3n], // 3.4667 -> 3
    ["1", 45n, 2n], // 1.5 -> 2 (half-up, not banker's)
    ["1", 15n, 1n], // 0.5 -> 1 (half-up)
    ["1", 14n, 0n], // 0.4667 -> 0
    ["0", 500n, 0n],
    ["12.5", 240n, 100n], // 12.5 x 240 / 30
    ["0.5", 90n, 2n], // 1.5 -> 2
    ["100", 0n, 0n],
    ["1000000", 999_999n, 33_333_300_000n],
  ])("%s GB at %s paisa -> %s paisa", (gb, price, expected) => {
    expect(dailyMeteredChargeMinor(gb, price)).toBe(expected);
  });

  it("is exact for large values (no float)", () => {
    expect(dailyMeteredChargeMinor("123456789012.345678", 9_007_199_254_740_993n)).toBe(
      37_066_663_266_157_200_137_744_976n,
    );
  });

  it("thirty days of one GB come to the monthly price", () => {
    const monthly = 3000n;
    expect(dailyMeteredChargeMinor("1", monthly) * 30n).toBe(monthly);
  });

  it.each(["", "-1", "1e3", "1,5", " 1", "abc", ".5", "5.", "NaN"])(
    "refuses the GB text %j",
    (gb) => {
      expect(() => dailyMeteredChargeMinor(gb, 100n)).toThrow(PricingInputError);
    },
  );
  it.each([5, undefined, null, 1.5])("refuses GB that is not text: %j", (gb) => {
    expect(() => dailyMeteredChargeMinor(gb as never, 100n)).toThrow(PricingInputError);
  });
  it.each([-1n, 1 as never, "100" as never, 1.5 as never])(
    "refuses the price (case %#)",
    (price) => {
      expect(() => dailyMeteredChargeMinor("1", price)).toThrow(PricingInputError);
    },
  );
});

describe("allowanceLevel", () => {
  it.each([
    ["0", "100", 0],
    ["79.99", "100", 0],
    ["80", "100", 80],
    ["99.99", "100", 80],
    ["100", "100", 100],
    ["250", "100", 100],
    ["8", "10", 80],
    ["7.9", "10", 0],
    ["1600.5", "2000", 80],
    ["0", "0.5", 0],
    ["0.4", "0.5", 80],
  ])("used %s of %s GB is level %s", (used, allowance, level) => {
    expect(allowanceLevel(used, allowance)).toBe(level);
  });
  it("an allowance of 0 is refused: nothing to measure against (fail closed)", () => {
    expect(() => allowanceLevel("1", "0")).toThrow(PricingInputError);
  });
  it.each(["-1", "x", ""])("refuses %j", (bad) => {
    expect(() => allowanceLevel(bad, "100")).toThrow(PricingInputError);
    expect(() => allowanceLevel("1", bad)).toThrow(PricingInputError);
  });
});

// WPU-M2. A metered charge is split like a purchase (spec 9.1): the amount of the charge is shared
// between the base and the steps in the proportions of the unit price, half-up, and the base takes
// what is left, so the lines always add up to the charge.
describe("splitMeteredChargeMinor", () => {
  // USD 0.005 x 127 = 0.635 -> base 64 paisa (half-up), korea_vat 10%, bd_vat 5%, fee, no margin.
  const UNIT = {
    totalMinor: 77n,
    baseMinor: 64n,
    steps: [
      { code: "korea_vat", amountMinor: 6n },
      { code: "bd_vat", amountMinor: 4n },
      { code: "processing_fee", amountMinor: 3n },
      { code: "markup", amountMinor: 0n },
    ],
  };

  it("one unit is the unit price itself", () => {
    expect(splitMeteredChargeMinor(77n, UNIT)).toEqual({
      baseMinor: 64n,
      steps: UNIT.steps,
    });
  });

  it("a part of a unit is shared in proportion, half-up, and the lines add up to the charge", () => {
    for (const charge of [1n, 2n, 3n, 10n, 33n, 100n, 7_700n, 123_457n]) {
      const split = splitMeteredChargeMinor(charge, UNIT);
      const sum = split.steps.reduce((a, s) => a + s.amountMinor, split.baseMinor);
      expect(sum).toBe(charge);
    }
    // 100 x 6/77 = 7.79 -> 8; 100 x 4/77 = 5.19 -> 5; 100 x 3/77 = 3.9 -> 4; base 83.
    expect(splitMeteredChargeMinor(100n, UNIT)).toEqual({
      baseMinor: 83n,
      steps: [
        { code: "korea_vat", amountMinor: 8n },
        { code: "bd_vat", amountMinor: 5n },
        { code: "processing_fee", amountMinor: 4n },
        { code: "markup", amountMinor: 0n },
      ],
    });
  });

  it("refuses a unit price whose lines do not add up, a zero unit and a negative charge (R16)", () => {
    expect(() => splitMeteredChargeMinor(5n, { ...UNIT, baseMinor: 65n })).toThrow(
      PricingInputError,
    );
    expect(() => splitMeteredChargeMinor(5n, { totalMinor: 0n, baseMinor: 0n, steps: [] })).toThrow(
      PricingInputError,
    );
    expect(() => splitMeteredChargeMinor(-1n, UNIT)).toThrow(PricingInputError);
  });
});
