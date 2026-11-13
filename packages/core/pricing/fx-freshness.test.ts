import { expect, it } from "vitest";
import {
  FX_CLOCK_SKEW_TOLERANCE_MS,
  FX_CONFIRM_PERCENT,
  FX_RATE_ALERT_AGE_DAYS,
  FX_RATE_MAX_AGE_DAYS,
  fxChangeNeedsConfirm,
  fxRateAlertDue,
  fxRateInSaneRange,
  fxRateState,
  rateIsFresh,
} from "./fx-rate";

const DAY = 86_400_000;
const now = new Date("2026-11-20T04:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

it("the owner's limits: a rate lives 7 days, the alert starts after 6, a change over 10 percent needs a confirm", () => {
  expect(FX_RATE_MAX_AGE_DAYS).toBe(7);
  expect(FX_RATE_ALERT_AGE_DAYS).toBe(6);
  expect(FX_CONFIRM_PERCENT).toBe(10n);
});

it("a rate set just now is fresh", () => {
  expect(rateIsFresh(now, now)).toBe(true);
});

it("a rate set 7 days minus one second ago is fresh", () => {
  expect(rateIsFresh(ago(7 * DAY - 1000), now)).toBe(true);
});

it("a rate set exactly 7 days ago is still fresh (the limit is a maximum age, inclusive)", () => {
  expect(rateIsFresh(ago(7 * DAY), now)).toBe(true);
});

it("a rate set 7 days plus one millisecond ago is stale", () => {
  expect(rateIsFresh(ago(7 * DAY + 1), now)).toBe(false);
});

it("a rate set 30 days ago is stale", () => {
  expect(rateIsFresh(ago(30 * DAY), now)).toBe(false);
});

it("a missing rate is never fresh (R16)", () => {
  expect(rateIsFresh(null, now)).toBe(false);
  expect(rateIsFresh(undefined, now)).toBe(false);
});

it("a date that is not a date is never fresh", () => {
  expect(rateIsFresh(new Date("nope"), now)).toBe(false);
  expect(rateIsFresh(now, new Date("nope"))).toBe(false);
  expect(rateIsFresh("2026-11-20" as unknown as Date, now)).toBe(false);
});

it("clock skew: a rate stamped a little ahead of the reader's clock counts as age 0", () => {
  const ahead = new Date(now.getTime() + FX_CLOCK_SKEW_TOLERANCE_MS);
  expect(rateIsFresh(ahead, now)).toBe(true);
});

it("clock skew: a rate stamped further ahead than the tolerance cannot be trusted (R16)", () => {
  const ahead = new Date(now.getTime() + FX_CLOCK_SKEW_TOLERANCE_MS + 1);
  expect(rateIsFresh(ahead, now)).toBe(false);
});

it("a custom maximum age is used; a maximum that is not a positive number refuses", () => {
  expect(rateIsFresh(ago(2 * DAY), now, 3)).toBe(true);
  expect(rateIsFresh(ago(3 * DAY + 1), now, 3)).toBe(false);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(rateIsFresh(now, now, bad)).toBe(false);
  }
});

it("fxRateState names missing, fresh, ageing (after 6 days) and stale (after 7 days)", () => {
  expect(fxRateState(null, now)).toBe("missing");
  expect(fxRateState(ago(DAY), now)).toBe("fresh");
  expect(fxRateState(ago(6 * DAY), now)).toBe("fresh");
  expect(fxRateState(ago(6 * DAY + 1), now)).toBe("ageing");
  expect(fxRateState(ago(7 * DAY), now)).toBe("ageing");
  expect(fxRateState(ago(7 * DAY + 1), now)).toBe("stale");
  expect(fxRateState(new Date("nope"), now)).toBe("stale");
});

it("fxRateAlertDue: only once the rate is older than 6 days, or missing, or unreadable", () => {
  expect(fxRateAlertDue(ago(6 * DAY), now)).toBe(false);
  expect(fxRateAlertDue(ago(6 * DAY + 1), now)).toBe(true);
  expect(fxRateAlertDue(ago(20 * DAY), now)).toBe(true);
  expect(fxRateAlertDue(null, now)).toBe(true);
});

it.each([
  ["no change", "127", "127", false],
  ["exactly 10 percent up", "127", "139.7", false],
  ["one millionth over 10 percent up", "127", "139.700001", true],
  ["exactly 10 percent down", "127", "114.3", false],
  ["one millionth over 10 percent down", "127", "114.299999", true],
  ["a rate ten times the old one (a slipped decimal point)", "127", "1270", true],
])("fxChangeNeedsConfirm: %s", (_, current, next, needs) => {
  expect(fxChangeNeedsConfirm(current, next)).toBe(needs);
});

it("the confirm percent is configurable", () => {
  expect(fxChangeNeedsConfirm("100", "103", 2n)).toBe(true);
  expect(fxChangeNeedsConfirm("100", "103", 3n)).toBe(false);
});

it("fxChangeNeedsConfirm refuses a rate that cannot be stored and a percent that is not positive", () => {
  expect(() => fxChangeNeedsConfirm("127", "1e3")).toThrow();
  expect(() => fxChangeNeedsConfirm("0", "127")).toThrow();
  expect(() => fxChangeNeedsConfirm("127", "130", 0n)).toThrow();
});

it("fxRateInSaneRange: inclusive bounds, plain text only", () => {
  expect(fxRateInSaneRange("50", { min: "50", max: "500" })).toBe(true);
  expect(fxRateInSaneRange("500", { min: "50", max: "500" })).toBe(true);
  expect(fxRateInSaneRange("49.999999", { min: "50", max: "500" })).toBe(false);
  expect(fxRateInSaneRange("500.000001", { min: "50", max: "500" })).toBe(false);
  expect(fxRateInSaneRange("12.7", { min: "50", max: "500" })).toBe(false);
  expect(fxRateInSaneRange("abc", { min: "50", max: "500" })).toBe(false);
  expect(fxRateInSaneRange("120", { min: "abc", max: "500" })).toBe(false);
});
