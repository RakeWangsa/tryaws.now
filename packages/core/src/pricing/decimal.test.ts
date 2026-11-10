import Big from "big.js";
import { expect, it } from "vitest";
import { parseDecimal, toMinor } from "./decimal";

it.each(["5", "9.50", "0.50", "127", "124.77", "0", "0.0333333333"])("parses %s", (text) => {
  expect(parseDecimal(text, "x").eq(new Big(text))).toBe(true);
});

it.each([0.1, ["0.1"], undefined])("refuses %s that is not text", (value) => {
  expect(() => parseDecimal(value as unknown as string, "fxRate")).toThrow(RangeError);
  expect(() => parseDecimal(value as unknown as string, "fxRate")).toThrow(/fxRate/);
});

it.each([
  "",
  " ",
  " 5",
  "abc",
  "-1",
  "+1",
  "1e3",
  "1,5",
  ".5",
  "5.",
  "NaN",
  "Infinity",
  "0x10",
  "1 000",
])("rejects %j and names the field", (text) => {
  expect(() => parseDecimal(text, "fxRate")).toThrow(RangeError);
  expect(() => parseDecimal(text, "fxRate")).toThrow(/fxRate/);
});

it.each([
  ["6032.5", 6033n],
  ["6032.49", 6032n],
  ["1587.5", 1588n],
  ["317.5", 318n],
  ["0.5", 1n],
  ["0.4999", 0n],
  ["74295", 74295n],
])("rounds %s half-up to %s", (text, minor) => {
  expect(toMinor(new Big(text))).toBe(minor);
});
