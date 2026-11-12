import { describe, expect, it } from "vitest";
import { safeLog } from "../log";

// WPU-B7 (L6): `reason` and `state` are fixed words, never free text (R14).
function run(fields: Record<string, unknown>): Record<string, unknown> {
  let seen: Record<string, unknown> = {};
  safeLog({ log: (_event, f) => void (seen = f as Record<string, unknown>) }, "eps.test", fields);
  return seen;
}

describe("safeLog fixed words", () => {
  it("keeps a fixed word under reason and state", () => {
    expect(run({ reason: "wallet_missing", state: "in_review" })).toEqual({
      reason: "wallet_missing",
      state: "in_review",
    });
  });
  it("drops free text under reason and state", () => {
    for (const bad of [
      "Error: ECONNRESET at 10.0.0.1",
      "https://pay.example/x?token=abc",
      "customer rahim@example.com",
      "01712345678",
      "Upper",
      "",
      "a".repeat(41),
      "line\nbreak",
    ]) {
      expect(run({ reason: bad, state: bad }), bad).toEqual({});
    }
  });
  it("still keeps the other keys and drops unnamed ones", () => {
    expect(run({ paymentId: "p-1", count: 2, ok: true, url: "x", reason: "exception" })).toEqual({
      paymentId: "p-1",
      count: 2,
      ok: true,
      reason: "exception",
    });
  });
});
