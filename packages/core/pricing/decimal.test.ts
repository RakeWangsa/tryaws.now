import Big from "big.js";
import { expect, it } from "vitest";
import { decimalAtMost, isPlainDecimal, isPositiveDecimal, parseDecimal, toMinor } from "./decimal";
import { PricingInputError } from "./errors";

const PARSES = ["5", "9.50", "0.50", "127", "124.77", "0", "0.0333333333"];
const REJECTS = [
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
];

it.each(PARSES)("parses %s", (text) => {
  expect(parseDecimal(text, "x").eq(new Big(text))).toBe(true);
});

it.each([0.1, ["0.1"], undefined])("refuses %s that is not text", (value) => {
  expect(() => parseDecimal(value, "fxRate")).toThrow(RangeError);
  expect(() => parseDecimal(value, "fxRate")).toThrow(/fxRate/);
});

it.each(REJECTS)("rejects %j and names the field", (text) => {
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

it.each(PARSES)("isPlainDecimal accepts %j", (text) => {
  expect(isPlainDecimal(text)).toBe(true);
});

it.each<unknown>([...REJECTS, 0.1, ["0.1"], undefined, null])(
  "isPlainDecimal refuses %j",
  (value) => {
    expect(isPlainDecimal(value)).toBe(false);
  },
);

it.each(["0.01", "127", "124.77", "0.0333333333"])("isPositiveDecimal accepts %j", (text) => {
  expect(isPositiveDecimal(text)).toBe(true);
});

it.each<unknown>(["0", "0.000", "00", "", "-1", "1e3", 0.5, null])(
  "isPositiveDecimal refuses %j",
  (value) => {
    expect(isPositiveDecimal(value)).toBe(false);
  },
);

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

it("throws a PricingInputError with one problem at the field", () => {
  const error = thrown(() => parseDecimal("1e3", "fxRate"));
  expect(error).toBeInstanceOf(PricingInputError);
  expect(error).toBeInstanceOf(RangeError);
  const { message, problems } = error as PricingInputError;
  expect(problems).toEqual([{ path: "fxRate", message }]);
});

it.each<[string, unknown]>([
  ["a BigInt", 10n],
  ["a symbol", Symbol("x")],
  ["an object without a prototype", Object.create(null)],
  ["a long string", "9".repeat(199) + "x"],
])("throws a PricingInputError, never a TypeError, for %s", (_, value) => {
  const error = thrown(() => parseDecimal(value, "fxRate"));
  expect(error).toBeInstanceOf(PricingInputError);
  expect((error as Error).message.length).toBeLessThan(120);
});

it("decimalAtMost compares plain decimals exactly", () => {
  expect(decimalAtMost("24", "24")).toBe(true);
  expect(decimalAtMost("24.0001", "24")).toBe(false);
  expect(decimalAtMost("0.1", "0.10")).toBe(true);
  expect(decimalAtMost("9.99", "24")).toBe(true);
  expect(decimalAtMost("0", "0")).toBe(true);
});

it("decimalAtMost throws RangeError for text that is not a plain decimal", () => {
  expect(() => decimalAtMost("abc", "1")).toThrow(RangeError);
  expect(() => decimalAtMost("1", "-1")).toThrow(RangeError);
  expect(() => decimalAtMost("1e3", "1")).toThrow(RangeError);
  expect(() => decimalAtMost("1", "")).toThrow(RangeError);
});
