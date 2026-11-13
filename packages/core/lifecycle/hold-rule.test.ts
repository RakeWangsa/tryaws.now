import { describe, expect, it } from "vitest";
import type { ErrorCode, Result } from "../types";
import { holdReasonOf, nextHoldMarker, staleHoldMarkers, type MarkerView } from "./hold-rule";

// WPU-Z1. The pure rules of the lifecycle hold, no database: which failed renewal is held and why, the marker
// that records it, and the markers that a renewal by hand leaves behind.

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-12-11T06:00:00.000Z");
const EARLIER = "2026-12-10T06:00:00.000Z";

// The refusal of WPU-Y1 (rates/fx-gate.ts): the rate is missing or older than 7 days.
const RATE_REFUSAL: Result<unknown> = {
  ok: false,
  error: "upstream_unavailable",
  fields: { fxRate: "stale" },
  data: { code: "prices_updating" },
};
const failed = (error: ErrorCode): Result<unknown> => ({ ok: false, error });

describe("which failed renewal is held", () => {
  it("a renewal that went through, or a wallet that is short (the customer's own reason), is not held", () => {
    expect(holdReasonOf({ ok: true, value: { totalMinor: "74295" } })).toBeNull();
    expect(
      holdReasonOf({
        ok: false,
        error: "insufficient_balance",
        data: { shortfallMinor: "100" },
      }),
    ).toBeNull();
  });

  it("a missing or stale USD to BDT rate is held for the rate, as before (WPU-Y1)", () => {
    expect(holdReasonOf(RATE_REFUSAL)).toEqual({ reason: "fx_rate" });
  });

  it("every other failure is held as price_unavailable with its code: the platform's fault is not the customer's (R16)", () => {
    // internal: a stored price snapshot that does not parse, or an applied plan that cannot be read; not_found: no
    // pricing rule in force; conflict: the ledger refused the posting.
    for (const error of ["internal", "not_found", "conflict", "validation"] as const) {
      expect(holdReasonOf(failed(error))).toEqual({ reason: "price_unavailable", error });
    }
  });

  it("an upstream_unavailable that is not the rate refusal is a price that cannot be had, not the rate", () => {
    expect(holdReasonOf(failed("upstream_unavailable"))).toEqual({
      reason: "price_unavailable",
      error: "upstream_unavailable",
    });
  });

  it("keeps the fixed code only: no field, data or reference of the failure goes on (R14)", () => {
    const why = holdReasonOf({
      ok: false,
      error: "internal",
      fields: { priceSnapshot: "invalid" },
      data: { detail: "something long" },
      ref: "r-1",
    });
    expect(why).toEqual({ reason: "price_unavailable", error: "internal" });
  });
});

describe("the hold marker (resources.config.fxRateHold)", () => {
  const price = (error: ErrorCode = "internal") =>
    ({ reason: "price_unavailable", error }) as const;

  it("is written with its start, the reason and, for a price that cannot be had, the code", () => {
    expect(nextHoldMarker(undefined, { reason: "fx_rate" }, NOW)).toEqual({
      since: NOW.toISOString(),
      reason: "fx_rate",
    });
    expect(nextHoldMarker(null, price(), NOW)).toEqual({
      since: NOW.toISOString(),
      reason: "price_unavailable",
      error: "internal",
    });
  });

  it("a repeat of the same hold writes nothing (R7)", () => {
    expect(
      nextHoldMarker(
        { since: EARLIER, reason: "price_unavailable", error: "internal" },
        price(),
        NOW,
      ),
    ).toBeNull();
    expect(nextHoldMarker({ since: EARLIER, reason: "fx_rate" }, { reason: "fx_rate" }, NOW)).toBe(
      null,
    );
  });

  it("a hold for another reason updates the reason and the code only: since never moves", () => {
    expect(nextHoldMarker({ since: EARLIER, reason: "fx_rate" }, price("not_found"), NOW)).toEqual({
      since: EARLIER,
      reason: "price_unavailable",
      error: "not_found",
    });
    expect(
      nextHoldMarker(
        { since: EARLIER, reason: "price_unavailable", error: "internal" },
        price("conflict"),
        NOW,
      ),
    ).toEqual({ since: EARLIER, reason: "price_unavailable", error: "conflict" });
    // Back to the rate: the code of the earlier price failure goes, the start stays.
    expect(
      nextHoldMarker(
        { since: EARLIER, reason: "price_unavailable", error: "internal" },
        { reason: "fx_rate" },
        NOW,
      ),
    ).toEqual({ since: EARLIER, reason: "fx_rate" });
  });

  it("a marker written before WPU-Z1 (its start only) keeps working: it gains the reason and keeps the start", () => {
    expect(nextHoldMarker({ since: EARLIER }, { reason: "fx_rate" }, NOW)).toEqual({
      since: EARLIER,
      reason: "fx_rate",
    });
    // A start that cannot be read is kept as it is too: the marker is never moved, only its reason is told.
    expect(nextHoldMarker({ since: "x" }, price(), NOW)).toEqual({
      since: "x",
      reason: "price_unavailable",
      error: "internal",
    });
  });

  it("a marker that is not an object still holds and is never rewritten (R16)", () => {
    for (const stored of [true, "held", 1, ["x"]]) {
      expect(nextHoldMarker(stored, price(), NOW)).toBeNull();
    }
  });
});

describe("the markers that a renewal by hand leaves behind", () => {
  // renewNow runs as web_rw, which cannot write resources.config: the hold marker and graceFrom of the period it
  // paid stay. On an active subscription whose period end is ahead they are stale.
  const view = (over: Partial<MarkerView> = {}): MarkerView => ({
    status: "active",
    periodEnd: new Date(NOW.getTime() + 30 * DAY),
    hold: { since: EARLIER, reason: "price_unavailable", error: "internal" },
    graceFrom: null,
    ...over,
  });

  it("are stale on an active subscription whose period end is ahead: a hold marker, a graceFrom, or both", () => {
    expect(staleHoldMarkers(view(), NOW)).toBe(true);
    expect(staleHoldMarkers(view({ hold: undefined, graceFrom: EARLIER }), NOW)).toBe(true);
    expect(staleHoldMarkers(view({ graceFrom: EARLIER }), NOW)).toBe(true);
    // A marker of the old form, or one that cannot be read, is a marker too.
    expect(staleHoldMarkers(view({ hold: { since: "x" } }), NOW)).toBe(true);
  });

  it("are live at or after the period end: a held renewal keeps its marker there", () => {
    expect(staleHoldMarkers(view({ periodEnd: NOW }), NOW)).toBe(false);
    expect(staleHoldMarkers(view({ periodEnd: new Date(NOW.getTime() - DAY) }), NOW)).toBe(false);
  });

  it("are live in every other state: grace, retained and ended keep them", () => {
    for (const status of ["grace", "retained", "ended"] as const) {
      expect(staleHoldMarkers(view({ status, graceFrom: EARLIER }), NOW)).toBe(false);
    }
  });

  it("nothing is cleared when neither is carried (a null is no marker)", () => {
    expect(staleHoldMarkers(view({ hold: null, graceFrom: null }), NOW)).toBe(false);
    expect(staleHoldMarkers(view({ hold: undefined, graceFrom: undefined }), NOW)).toBe(false);
  });

  it("a period end or a clock that cannot be read clears nothing (R16)", () => {
    expect(staleHoldMarkers(view({ periodEnd: new Date("nope") }), NOW)).toBe(false);
    expect(staleHoldMarkers(view(), new Date("nope"))).toBe(false);
  });
});
