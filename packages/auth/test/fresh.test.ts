import { afterEach, describe, expect, it, vi } from "vitest";
import { requireFreshSignIn } from "../fresh";
import type { CustomerSession } from "../types";

const NOW = new Date("2026-11-11T10:00:00.000Z");
const clock = { now: () => NOW };
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function session(
  signedInAt: Date,
  customerId = "11111111-1111-4111-8111-111111111111",
): CustomerSession {
  return { customerId, kycStatus: "verified", riskTier: "trusted", locale: "bn", signedInAt };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requireFreshSignIn", () => {
  it("a sign-in one second ago is fresh", () => {
    expect(requireFreshSignIn(session(ago(1000)), clock)).toEqual({ ok: true, value: true });
  });

  it("a sign-in exactly 10 minutes ago is fresh", () => {
    expect(requireFreshSignIn(session(ago(10 * 60_000)), clock)).toEqual({ ok: true, value: true });
  });

  it("a sign-in 10 minutes and one millisecond ago is not fresh", () => {
    expect(requireFreshSignIn(session(ago(10 * 60_000 + 1)), clock).ok).toBe(false);
  });

  it("the refusal is unauthenticated with the reason fresh_sign_in_required", () => {
    expect(requireFreshSignIn(session(ago(3600_000)), clock)).toEqual({
      ok: false,
      error: "unauthenticated",
      data: { reason: "fresh_sign_in_required" },
    });
  });

  it("a sign-in 59 seconds in the future is fresh (clock skew)", () => {
    expect(requireFreshSignIn(session(ago(-59_000)), clock).ok).toBe(true);
  });

  it("a sign-in exactly 60 seconds in the future is still within the skew", () => {
    expect(requireFreshSignIn(session(ago(-60_000)), clock).ok).toBe(true);
  });

  it("a sign-in 61 seconds in the future is refused", () => {
    expect(requireFreshSignIn(session(ago(-61_000)), clock)).toEqual({
      ok: false,
      error: "unauthenticated",
      data: { reason: "fresh_sign_in_required" },
    });
  });

  it("an invalid Date is refused", () => {
    expect(requireFreshSignIn(session(new Date(Number.NaN)), clock).ok).toBe(false);
    expect(requireFreshSignIn(session("2026-11-11" as unknown as Date), clock).ok).toBe(false);
    expect(requireFreshSignIn(session(undefined as unknown as Date), clock).ok).toBe(false);
  });

  it("the clock decides, not Date.now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW.getTime() + 3600_000));
    expect(requireFreshSignIn(session(ago(1000)), clock).ok).toBe(true);
    // and the other way: the injected clock is old, the real one is fresh
    expect(requireFreshSignIn(session(new Date(Date.now())), clock).ok).toBe(false);
  });

  it("the function does not read the customer id", () => {
    expect(requireFreshSignIn(session(ago(1000), ""), clock).ok).toBe(true);
    expect(requireFreshSignIn(session(ago(3600_000), "valid-looking-id"), clock).ok).toBe(false);
  });
});
