import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTopUpAmount, quickAmountMinors } from "./topup-amount";

const range = { minMinor: 10000n, maxMinor: 50000000n };

describe("parseTopUpAmount", () => {
  it.each([
    ["1500", 150000n],
    ["১৫০০", 150000n],
    ["1,500", 150000n],
    ["1,50,000", 15000000n],
    [" 500 ", 50000n],
    ["5 00", 50000n],
    ["5 00", 50000n],
  ])("%j is %s paisa", (text, minor) => {
    expect(parseTopUpAmount(text, range)).toEqual({ ok: true, amountMinor: minor });
  });

  it.each([
    "500.00",
    "500.5",
    "-500",
    "+500",
    "৳500",
    "1e3",
    "0x10",
    "５００",
    "٥٠٠",
    "500\n600",
    "1234567890",
    "12345678901234567890",
  ])("%j is a format error", (text) => {
    expect(parseTopUpAmount(text, range)).toEqual({ ok: false, error: "format" });
  });

  it.each(["", "   ", ",", " , "])("%j is required", (text) => {
    expect(parseTopUpAmount(text, range)).toEqual({ ok: false, error: "required" });
  });

  it("refuses below the minimum and above the maximum, accepts the boundaries", () => {
    expect(parseTopUpAmount("99", range)).toEqual({ ok: false, error: "too_low" });
    expect(parseTopUpAmount("100", range)).toEqual({ ok: true, amountMinor: 10000n });
    expect(parseTopUpAmount("500000", range)).toEqual({ ok: true, amountMinor: 50000000n });
    expect(parseTopUpAmount("500001", range)).toEqual({ ok: false, error: "too_high" });
  });

  it.each([undefined, null, 500, {}, [], 500n])("%s (not a string) is a format error", (v) => {
    expect(parseTopUpAmount(v, range)).toEqual({ ok: false, error: "format" });
  });
});

describe("quickAmountMinors", () => {
  it("keeps whole taka inside the range, ascending, unique", () => {
    expect(
      quickAmountMinors([500, 1000, 1000, "x", 1.5, -1, 0, 1e21, Number.NaN, 2_000_000], range),
    ).toEqual([50000n, 100000n]);
  });

  it("sorts ascending", () => {
    expect(quickAmountMinors([2000, 500], range)).toEqual([50000n, 200000n]);
  });

  it("keeps at most six", () => {
    const six = quickAmountMinors([200, 300, 400, 500, 600, 700, 800], range);
    expect(six).toHaveLength(6);
    expect(six[5]).toBe(70000n);
  });
});

it("the parser source holds no float or Number call", () => {
  const src = readFileSync(new URL("./topup-amount.ts", import.meta.url), "utf8");
  for (const bad of ["Number(", "parseInt(", "parseFloat(", "toFixed(", "Math."]) {
    expect(src.includes(bad), bad).toBe(false);
  }
});
