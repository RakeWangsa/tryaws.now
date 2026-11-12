import { describe, expect, it } from "vitest";
import { roundedShareMinor } from "./vat-check";

// WPU-I5: the one place where an invoice multiplies a value by a stored rate to check the VAT it prints.
// Half-up, integers in and out (R4); spec 8 vector 44 USD: base 558800, bd_vat 5% = 27940.
describe("roundedShareMinor", () => {
  it("is round_half_up(value x rate) in whole minor units", () => {
    expect(roundedShareMinor(558800n, "0.05")).toBe(27940n);
    expect(roundedShareMinor(10000n, "0.055")).toBe(550n);
    expect(roundedShareMinor(0n, "0.05")).toBe(0n);
  });
  it("rounds a half up, never to even or down", () => {
    expect(roundedShareMinor(10n, "0.05")).toBe(1n); // 0.5 -> 1
    expect(roundedShareMinor(30n, "0.05")).toBe(2n); // 1.5 -> 2
    expect(roundedShareMinor(29n, "0.05")).toBe(1n); // 1.45 -> 1
    expect(roundedShareMinor(650000000000000001n, "0.05")).toBe(32500000000000000n);
  });
  it("the value the old page printed does not satisfy the rate (the bug of the review)", () => {
    expect(roundedShareMinor(625856n, "0.05")).not.toBe(27940n);
  });
  it("refuses what is not a non-negative bigint and a plain decimal rate (R16)", () => {
    expect(() => roundedShareMinor(-1n, "0.05")).toThrow(RangeError);
    expect(() => roundedShareMinor(1n, "5%")).toThrow();
    expect(() => roundedShareMinor(1n, "-0.05")).toThrow();
    expect(() => roundedShareMinor(1 as unknown as bigint, "0.05")).toThrow(RangeError);
  });
});
