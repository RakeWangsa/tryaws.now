import { expect, it } from "vitest";
import { PricingInputError } from "./errors";
import {
  FX_SECOND_ADMIN_PERCENT,
  FX_SINGLE_ADMIN_PERCENT,
  FX_SINGLE_ADMIN_WINDOW_HOURS,
  fxChangeNeedsSecondAdmin,
  fxSingleAdminApproval,
  fxWithinSingleAdminWindow,
  isFxRateText,
} from "./fx-rate";

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

// ---------------------------------------------------------------------------------------------------------
// WPU-X9 (owner decision 2026-11-14, "alone, within ±3%"): one admin may set the first rate of a market, and any
// later rate that is at most 3 percent away from the rate in force. A larger change keeps the second admin.
// ---------------------------------------------------------------------------------------------------------

it("WPU-X9: the single-admin limit is 3 percent (owner decision 2026-11-14)", () => {
  expect(FX_SINGLE_ADMIN_PERCENT).toBe(3n);
});

it.each([
  ["exactly +3 percent", "100", "103", "single_admin_within_limit"],
  ["exactly -3 percent", "100", "97", "single_admin_within_limit"],
  ["+3.000001 percent", "100", "103.000001", null],
  ["-3.000001 percent", "100", "96.999999", null],
  ["exactly +3 percent of 122", "122", "125.66", "single_admin_within_limit"],
  ["a millionth above +3 percent of 122", "122", "125.660001", null],
  ["exactly -3 percent of 122", "122", "118.34", "single_admin_within_limit"],
  ["a millionth below -3 percent of 122", "122", "118.339999", null],
  ["the same rate (a re-confirm)", "122", "122.000", "single_admin_within_limit"],
  ["a 0.4 percent step", "122", "122.5", "single_admin_within_limit"],
  ["a 10 percent change", "122", "134.2", null],
  ["the smallest rate, unchanged", "0.000001", "0.000001", "single_admin_within_limit"],
  ["a doubling of the smallest rate", "0.000001", "0.000002", null],
])("fxSingleAdminApproval: %s", (_, current, next, expected) => {
  expect(fxSingleAdminApproval(current, next, true)).toBe(expected);
});

it("fxSingleAdminApproval: the first rate of a market (none in force and none ever) is single admin", () => {
  expect(fxSingleAdminApproval(null, "122", false)).toBe("single_admin_first_rate");
});

it("fxSingleAdminApproval: no rate in force but one stored before (or scheduled) needs a second admin", () => {
  expect(fxSingleAdminApproval(null, "122", true)).toBeNull();
});

// WPU-X9 fix round 1 (owner decision 2026-11-14, "Yes: 3% per 24 hours"; money and security review): a change alone
// must be within 3 percent of EVERY rate in force during the 24 hours before it, so small steps cannot add up.
it("WPU-X9: the single-admin window is 24 hours", () => {
  expect(FX_SINGLE_ADMIN_WINDOW_HOURS).toBe(24);
});

it.each([
  ["one rate, exactly -3 percent", ["122"], "118.34", true],
  ["the chained step 122 -> 118.34 -> 114.79", ["122", "118.34"], "114.79", false],
  ["exactly -3 percent of the oldest rate of the window", ["122", "119"], "118.34", true],
  ["exactly +3 percent of the oldest and within of the newer", ["100", "102"], "103", true],
  ["a millionth past +3 percent of the oldest", ["100", "102"], "103.000001", false],
  ["within the oldest but past the newest", ["100", "106"], "102.8", false],
  ["the same rate again (a re-confirm)", ["122", "122"], "122", true],
])("fxWithinSingleAdminWindow: %s", (_, rates, next, ok) => {
  expect(fxWithinSingleAdminWindow(rates, next)).toBe(ok);
});

it.each([
  ["no rate at all (unknown history)", [], "122"],
  ["an unreadable rate in the window", ["122", null], "122"],
  ["a malformed rate in the window", ["122", "1e2"], "122"],
  ["a number in the window", [122], "122"],
  ["a malformed new rate", ["122"], "122.1234567"],
  ["a window that is not a list", null, "122"],
])("fxWithinSingleAdminWindow fails closed to a second admin (R16): %s", (_, rates, next) => {
  expect(fxWithinSingleAdminWindow(rates as never, next as never)).toBe(false);
});

it.each([
  ["a current rate that is text", "abc", "122", true],
  ["a current rate with an exponent", "1e2", "100", true],
  ["a current rate of zero", "0", "0.000001", true],
  ["an empty current rate", "", "122", true],
  ["a current rate that is a number", 122, "122", true],
  ["a new rate that is malformed", "122", "122.1234567", true],
  ["a new rate that is a number", "122", 122, true],
  ["a first rate that is malformed", null, "1,5", false],
  ["no rate in force and an unknown history", null, "122", undefined],
  ["no rate in force and a history that is not a boolean", null, "122", "false"],
])("fxSingleAdminApproval fails closed to a second admin: %s", (_, current, next, before) => {
  expect(fxSingleAdminApproval(current as never, next as never, before as never)).toBeNull();
});
