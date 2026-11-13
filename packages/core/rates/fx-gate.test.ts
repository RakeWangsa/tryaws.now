import { expect, it } from "vitest";
import { FX_RATE_UNAVAILABLE_CODE, fxFreshnessRefusal, isFxRateUnavailable } from "./fx-gate";

const now = new Date("2026-11-20T04:00:00.000Z");
const DAY = 86_400_000;
// A rate entered `ms` ago that started when it was entered.
const rateFrom = (ms: number) => ({
  effectiveFrom: new Date(now.getTime() - ms),
  createdAt: new Date(now.getTime() - ms),
});

it("a fresh rate gives no refusal", () => {
  expect(fxFreshnessRefusal(rateFrom(DAY), now)).toBeNull();
  expect(fxFreshnessRefusal(rateFrom(7 * DAY), now)).toBeNull();
  expect(fxFreshnessRefusal(rateFrom(7 * DAY - 1000), now)).toBeNull();
});

it("a stale rate is refused with the stable code and no internals", () => {
  const refused = fxFreshnessRefusal(rateFrom(7 * DAY + 1), now);
  expect(refused).toEqual({
    ok: false,
    error: "upstream_unavailable",
    fields: { fxRate: "stale" },
    data: { code: FX_RATE_UNAVAILABLE_CODE },
  });
  expect(FX_RATE_UNAVAILABLE_CODE).toBe("prices_updating");
});

it("a missing rate is refused with the same stable code", () => {
  expect(fxFreshnessRefusal(null, now)).toEqual({
    ok: false,
    error: "upstream_unavailable",
    fields: { fxRate: "missing" },
    data: { code: FX_RATE_UNAVAILABLE_CODE },
  });
});

it("a rate whose start is in the future beyond the clock tolerance is not in force: refused (R16)", () => {
  const future = new Date(now.getTime() + DAY);
  expect(fxFreshnessRefusal({ effectiveFrom: future, createdAt: now }, now)).not.toBeNull();
});

it("an unreadable clock or entry time refuses", () => {
  expect(fxFreshnessRefusal(rateFrom(DAY), new Date("nope"))).not.toBeNull();
  expect(
    fxFreshnessRefusal({ effectiveFrom: now, createdAt: new Date("nope") }, now),
  ).not.toBeNull();
});

// WPU-Y9 finding 2: the age counts from the ENTRY, not from the start the rate names.
it("a rate entered 7 days ago and scheduled to start later is stale although its start is recent", () => {
  const entered = new Date(now.getTime() - 7 * DAY - 1);
  const started = new Date(now.getTime() - 1000);
  expect(fxFreshnessRefusal({ effectiveFrom: started, createdAt: entered }, now)).toMatchObject({
    fields: { fxRate: "stale" },
  });
});

it("the boundary: entered exactly 7 days ago is still fresh, one millisecond more is stale", () => {
  const started = new Date(now.getTime() - 1000);
  const at = (ageMs: number) => ({
    effectiveFrom: started,
    createdAt: new Date(now.getTime() - ageMs),
  });
  expect(fxFreshnessRefusal(at(7 * DAY), now)).toBeNull();
  expect(fxFreshnessRefusal(at(7 * DAY + 1), now)).not.toBeNull();
});

it("a rate entered 3 days ago for a start 3 days later is fresh only from its start, and for 4 more days", () => {
  const entered = new Date(now.getTime() - 3 * DAY);
  // not yet started 1 day before its start
  expect(
    fxFreshnessRefusal(
      { effectiveFrom: new Date(now.getTime() + 2 * DAY), createdAt: entered },
      now,
    ),
  ).not.toBeNull();
  // 4 days after the start it is 7 days from its entry: still fresh; a second later it is stale
  const later = new Date(entered.getTime() + 7 * DAY);
  const start = new Date(entered.getTime() + 3 * DAY);
  expect(fxFreshnessRefusal({ effectiveFrom: start, createdAt: entered }, later)).toBeNull();
  expect(
    fxFreshnessRefusal({ effectiveFrom: start, createdAt: entered }, new Date(later.getTime() + 1)),
  ).not.toBeNull();
});

it("isFxRateUnavailable recognises exactly this refusal", () => {
  expect(isFxRateUnavailable(fxFreshnessRefusal(null, now))).toBe(true);
  expect(isFxRateUnavailable({ ok: false, error: "upstream_unavailable" })).toBe(false);
  expect(
    isFxRateUnavailable({ ok: false, error: "not_found", data: { code: "prices_updating" } }),
  ).toBe(false);
  expect(isFxRateUnavailable({ ok: true, value: 1 })).toBe(false);
  expect(isFxRateUnavailable(null)).toBe(false);
});
