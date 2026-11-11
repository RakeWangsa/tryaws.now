import { expect, it } from "vitest";
import { formatEpsAmount, parseEpsAmount } from "../amount";

it("turns the decimal string of EPS into paisa with integers only", () => {
  expect(parseEpsAmount("1500.00")).toBe(150000n);
  expect(parseEpsAmount("1500")).toBe(150000n);
  expect(parseEpsAmount("0.5")).toBe(50n);
  expect(parseEpsAmount("0.05")).toBe(5n);
  expect(parseEpsAmount("0")).toBe(0n);
  expect(parseEpsAmount("0.00")).toBe(0n);
  expect(parseEpsAmount("999999999999999.99")).toBe(99999999999999999n);
});

it("refuses everything else: a float, a separator, a sign, an exponent, three decimals, a number", () => {
  for (const bad of [
    "1,500.00",
    "-1",
    "+1",
    "1e3",
    "1500.001",
    ".5",
    "1.",
    "NaN",
    "Infinity",
    "",
    " 1",
    "1 ",
    "٣",
    "1000000000000000",
  ])
    expect(parseEpsAmount(bad), bad).toBeNull();
  for (const notText of [1500, 1500.0, null, undefined, {}, ["1"], 10n])
    expect(parseEpsAmount(notText)).toBeNull();
});

it("formats paisa back to the decimal string and refuses a non-positive amount", () => {
  expect(formatEpsAmount(150000n)).toBe("1500.00");
  expect(formatEpsAmount(5n)).toBe("0.05");
  expect(formatEpsAmount(100n)).toBe("1.00");
  expect(() => formatEpsAmount(0n)).toThrow(RangeError);
  expect(() => formatEpsAmount(-1n)).toThrow(RangeError);
  expect(() => formatEpsAmount(10n ** 17n)).toThrow(RangeError);
  expect(formatEpsAmount(10n ** 17n - 1n)).toBe("999999999999999.99");
});

it("round-trips for 2000 pseudo-random amounts without a float", () => {
  let n = 12345n;
  for (let i = 0; i < 2000; i++) {
    n = (n * 6364136223846793005n + 1442695040888963407n) % 10n ** 17n;
    const m = n + 1n;
    expect(parseEpsAmount(formatEpsAmount(m))).toBe(m);
  }
});
