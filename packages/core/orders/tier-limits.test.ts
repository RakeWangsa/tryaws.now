import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_LIMITS, tierLimitsFromStored } from "./gates";

// WPU-G10. The limits of a tier: the defaults when no row is stored, the stored row when it parses, and
// a refusal (R16) when a row is there and cannot be read.
const stored = {
  maxInstances: 7,
  maxBundleUsd: "40",
  windows: true,
  containers: false,
  maxStaticIps: 2,
};

describe("tierLimitsFromStored", () => {
  it("uses the defaults of the core when the market has no row for the tier", () => {
    expect(tierLimitsFromStored("new", { state: "none" })).toEqual({
      ok: true,
      value: DEFAULT_TIER_LIMITS.new,
    });
    expect(tierLimitsFromStored("trusted", { state: "none" })).toEqual({
      ok: true,
      value: DEFAULT_TIER_LIMITS.trusted,
    });
  });

  it("uses the stored limits when the row parses", () => {
    expect(tierLimitsFromStored("new", { state: "ok", limits: stored })).toEqual({
      ok: true,
      value: stored,
    });
  });

  it("refuses a row that is there and cannot be read: the defaults are not a fallback (R16)", () => {
    expect(tierLimitsFromStored("new", { state: "invalid" })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("refuses a tier it does not know, whatever was read", () => {
    for (const read of [
      { state: "none" } as const,
      { state: "invalid" } as const,
      { state: "ok", limits: stored } as const,
    ]) {
      expect(tierLimitsFromStored("vip", read)).toEqual({ ok: false, error: "forbidden" });
    }
  });

  it("still checks the count of a stored row that was altered behind the repository", () => {
    expect(
      tierLimitsFromStored("new", { state: "ok", limits: { ...stored, maxInstances: 0 } }),
    ).toEqual({ ok: false, error: "forbidden" });
  });
});
