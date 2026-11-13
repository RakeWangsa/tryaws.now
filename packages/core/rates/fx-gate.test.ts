import { expect, it } from "vitest";
import { FX_RATE_UNAVAILABLE_CODE, fxFreshnessRefusal, isFxRateUnavailable } from "./fx-gate";

const now = new Date("2026-11-20T04:00:00.000Z");
const DAY = 86_400_000;
const rateFrom = (ms: number) => ({ effectiveFrom: new Date(now.getTime() - ms) });

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

it("a rate from the future beyond the clock tolerance is refused (R16)", () => {
  expect(fxFreshnessRefusal({ effectiveFrom: new Date(now.getTime() + DAY) }, now)).not.toBeNull();
});

it("an unreadable clock refuses", () => {
  expect(fxFreshnessRefusal(rateFrom(DAY), new Date("nope"))).not.toBeNull();
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
