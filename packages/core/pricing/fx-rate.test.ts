import { expect, it } from "vitest";
import { PricingInputError } from "./errors";
import { FX_SECOND_ADMIN_PERCENT, fxChangeNeedsSecondAdmin, isFxRateText } from "./fx-rate";

it("the limit is 5 percent (JOURNEY decision 15)", () => {
  expect(FX_SECOND_ADMIN_PERCENT).toBe(5n);
});

it.each([
  ["127", true],
  ["124.77", true],
  ["0.5", true],
  ["0.000001", true],
  ["999999.999999", true],
  ["127.0", true],
  ["", false],
  ["0", false],
  ["0.000000", false],
  ["-1", false],
  ["1e3", false],
  [" 127", false],
  ["1,5", false],
  ["127.1234567", false],
  ["1000000", false],
  ["00.5", false],
  [".5", false],
  ["5.", false],
  [127, false],
  [null, false],
])("isFxRateText(%j) is %s", (text, ok) => {
  expect(isFxRateText(text)).toBe(ok);
});

it.each([
  ["no change", "127", "127", false],
  ["exactly 5 percent up", "127", "133.35", false],
  ["one millionth over 5 percent up", "127", "133.350001", true],
  ["exactly 5 percent down", "127", "120.65", false],
  ["one millionth over 5 percent down", "127", "120.649999", true],
  ["4.19 percent up", "124.77", "130", false],
  ["5.0012 percent up", "124.77", "131.01", true],
  ["a rate a tenth of the old one (12.7 for 127)", "127", "12.7", true],
  ["a rate ten times the old one", "127", "1270", true],
  ["exactly 5 percent up on a small rate", "0.5", "0.525", false],
  ["a hair over 5 percent up on a small rate", "0.5", "0.525001", true],
])("fxChangeNeedsSecondAdmin: %s", (_, current, next, needs) => {
  expect(fxChangeNeedsSecondAdmin(current, next)).toBe(needs);
});

it.each([
  ["currentFxRate", "0", "1"],
  ["nextFxRate", "127", "abc"],
  ["nextFxRate", "127", "1.1234567"],
  ["currentFxRate", "1e3", "127"],
])("a %s that is no storable rate is refused, naming the field", (field, current, next) => {
  const call = () => fxChangeNeedsSecondAdmin(current, next);
  expect(call).toThrow(PricingInputError);
  expect(call).toThrow(new RegExp(field));
});
