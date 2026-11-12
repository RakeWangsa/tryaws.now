import { describe, expect, it } from "vitest";
import { prorateMinor } from "./prorata";

// WPU-M3: a share of an amount of paisa by whole days, rounded half-up, no floats (R4).
describe("prorateMinor", () => {
  it.each([
    // [amount, part days, whole days, expected]
    [3000n, 15, 30, 1500n],
    [3000n, 30, 30, 3000n],
    [3000n, 0, 30, 0n],
    [1000n, 1, 3, 333n], // 333.33 rounds down
    [1000n, 2, 3, 667n], // 666.67 rounds up
    [1n, 1, 2, 1n], // 0.5 rounds half UP
    [3n, 1, 2, 2n], // 1.5 rounds half up
    [5n, 1, 10, 1n], // 0.5 half up
    [4n, 1, 8, 1n], // 0.5 half up
    [9_000_000_000_000_000n, 7, 30, 2_100_000_000_000_000n], // far above 2^53, exact
  ])("prorates %s by %s/%s days to %s", (amount, part, whole, expected) => {
    expect(prorateMinor(amount, part, whole)).toBe(expected);
  });

  it("refuses a negative amount, a part above the whole, and non-integer or zero days (R16)", () => {
    expect(() => prorateMinor(-1n, 1, 30)).toThrow(RangeError);
    expect(() => prorateMinor(100n, 31, 30)).toThrow(RangeError);
    expect(() => prorateMinor(100n, -1, 30)).toThrow(RangeError);
    expect(() => prorateMinor(100n, 1.5, 30)).toThrow(RangeError);
    expect(() => prorateMinor(100n, 1, 0)).toThrow(RangeError);
    expect(() => prorateMinor(100 as never, 1, 30)).toThrow(RangeError);
  });
});
