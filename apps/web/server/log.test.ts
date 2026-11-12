import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLog } from "./log.ts";

// WPU-B7 (L6): `reason` and `state` are fixed words, never free text (R14).
afterEach(() => vi.restoreAllMocks());

function written(entry: Record<string, unknown>): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  writeLog(entry);
  const line = spy.mock.calls[0]?.[0];
  return typeof line === "string" ? (JSON.parse(line) as Record<string, unknown>) : {};
}

describe("writeLog fixed words", () => {
  it("keeps a fixed word under reason and state", () => {
    expect(written({ event: "e", reason: "read_or_price", state: "flag_off" })).toEqual({
      event: "e",
      reason: "read_or_price",
      state: "flag_off",
    });
  });
  it("drops free text under reason and state, keeps the event", () => {
    for (const bad of [
      "connect ECONNREFUSED 10.0.0.5:5432",
      "https://x.example/?t=1",
      "rahim@example.com",
      "+8801712345678",
      "Mixed Case",
      "",
      "z".repeat(41),
    ]) {
      expect(written({ event: "e", reason: bad, state: bad }), bad).toEqual({ event: "e" });
    }
  });
  it("still drops unnamed keys and object values", () => {
    expect(written({ event: "e", token: "t", requestId: "r1", reason: { a: 1 } })).toEqual({
      event: "e",
      requestId: "r1",
    });
  });
});
