import { expect, it } from "vitest";
import { MAX_CATCH_UP_AFTER_REFRESH_MS, staleWindowMs } from "./stale-window";

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

it("no earlier rate: no gap, no extra look-back", () => {
  expect(staleWindowMs(null, at("2026-11-20T00:00:00Z"), at("2026-11-20T00:01:00Z"))).toBe(0);
});

it("the earlier rate was replaced before it grew stale: no gap", () => {
  const prev = at("2026-11-10T00:00:00Z");
  const current = at("2026-11-17T00:00:00Z"); // exactly 7 days: the old rate was still fresh
  expect(staleWindowMs(prev, current, at("2026-11-17T00:01:00Z"))).toBe(0);
});

it("a gap of two days: the window runs from the end of the earlier rate's 7 days to now", () => {
  const prev = at("2026-11-10T00:00:00Z"); // fresh until 17 November 00:00
  const current = at("2026-11-19T00:00:00Z"); // refreshed two days late
  const now = at("2026-11-19T00:01:00Z");
  expect(staleWindowMs(prev, current, now)).toBe(2 * DAY + 60_000);
});

it("the window closes once the refreshed rate is older than the catch-up limit (3 days)", () => {
  const prev = at("2026-11-10T00:00:00Z");
  const current = at("2026-11-19T00:00:00Z");
  expect(MAX_CATCH_UP_AFTER_REFRESH_MS).toBe(3 * DAY);
  expect(staleWindowMs(prev, current, new Date(current.getTime() + 3 * DAY))).toBeGreaterThan(0);
  expect(staleWindowMs(prev, current, new Date(current.getTime() + 3 * DAY + 1))).toBe(0);
});

it("before the refreshed rate takes effect there is nothing to catch up", () => {
  const prev = at("2026-11-10T00:00:00Z");
  const current = at("2026-11-19T00:00:00Z");
  expect(staleWindowMs(prev, current, at("2026-11-18T00:00:00Z"))).toBe(0);
});

it("unreadable times give 0 (the normal window)", () => {
  expect(
    staleWindowMs(new Date("nope"), at("2026-11-19T00:00:00Z"), at("2026-11-19T00:00:00Z")),
  ).toBe(0);
});

it("the look-back is capped at 60 days", () => {
  const prev = at("2026-01-01T00:00:00Z");
  const current = at("2026-11-19T00:00:00Z");
  expect(staleWindowMs(prev, current, at("2026-11-19T00:01:00Z"))).toBe(60 * DAY);
});
