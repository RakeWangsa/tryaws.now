import { describe, expect, it } from "vitest";
import { PricingInputError } from "./errors";
import { allowanceLevel, dailyMeteredChargeMinor } from "./metering";

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
