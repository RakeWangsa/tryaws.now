import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_LIMITS,
  checkCustomer,
  checkLimits,
  type CustomerFacts,
  type ProductFacts,
} from "./gates";

const OK: CustomerFacts = {
  status: "active",
  kycStatus: "verified",
  riskTier: "new",
  market: "BD",
};

describe("checkCustomer", () => {
  it("accepts the one good row and returns the tier and market from the row", () => {
    expect(checkCustomer(OK)).toEqual({ ok: true, value: { riskTier: "new", market: "BD" } });
    expect(checkCustomer({ ...OK, riskTier: "trusted" })).toEqual({
      ok: true,
      value: { riskTier: "trusted", market: "BD" },
    });
  });

  it("refuses a missing row as forbidden", () => {
    expect(checkCustomer(null)).toEqual({ ok: false, error: "forbidden" });
  });

  it("refuses a status other than active as forbidden", () => {
    for (const status of ["suspended", "closed", "", "ACTIVE"]) {
      expect(checkCustomer({ ...OK, status })).toEqual({ ok: false, error: "forbidden" });
    }
  });

  it("refuses every KYC value but verified as kyc_required", () => {
    for (const kycStatus of ["none", "pending", "rejected", "VERIFIED", "", "unknown"]) {
      expect(checkCustomer({ ...OK, kycStatus })).toEqual({ ok: false, error: "kyc_required" });
    }
  });

  it("refuses an unknown risk tier as forbidden", () => {
    for (const riskTier of ["", "vip", "NEW"]) {
      expect(checkCustomer({ ...OK, riskTier })).toEqual({ ok: false, error: "forbidden" });
    }
  });

  it("checks the status before the KYC", () => {
    expect(checkCustomer({ ...OK, status: "suspended", kycStatus: "none" })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("checkLimits", () => {
  const product = (over: Partial<ProductFacts> = {}): ProductFacts => ({
    bundleUsd: "5",
    windows: false,
    staticIps: 1,
    ...over,
  });
  const limit = (error: string) => ({
    ok: false,
    error: "limit_reached",
    fields: { limit: error },
  });

  it("holds the documented defaults of 10.2", () => {
    expect(DEFAULT_TIER_LIMITS.new).toEqual({
      maxInstances: 2,
      maxBundleUsd: "24",
      windows: false,
      containers: false,
      maxStaticIps: 1,
    });
    expect(DEFAULT_TIER_LIMITS.trusted.maxInstances).toBe(20);
    expect(DEFAULT_TIER_LIMITS.trusted.windows).toBe(true);
  });

  it("allows the 2nd instance and refuses the 3rd for the new tier", () => {
    const l = DEFAULT_TIER_LIMITS.new;
    expect(checkLimits(l, { instances: 1 }, product())).toEqual({ ok: true, value: true });
    expect(checkLimits(l, { instances: 2 }, product())).toEqual(limit("instances"));
  });

  it("allows the 20th instance and refuses the 21st for the trusted tier", () => {
    const l = DEFAULT_TIER_LIMITS.trusted;
    expect(checkLimits(l, { instances: 19 }, product())).toEqual({ ok: true, value: true });
    expect(checkLimits(l, { instances: 20 }, product())).toEqual(limit("instances"));
  });

  it("compares the bundle price exactly", () => {
    const l = DEFAULT_TIER_LIMITS.new;
    expect(checkLimits(l, { instances: 0 }, product({ bundleUsd: "24" })).ok).toBe(true);
    expect(checkLimits(l, { instances: 0 }, product({ bundleUsd: "9.99" })).ok).toBe(true);
    expect(checkLimits(l, { instances: 0 }, product({ bundleUsd: "24.0001" }))).toEqual(
      limit("bundle_price"),
    );
  });

  it("refuses Windows for a tier without it and allows it for trusted", () => {
    expect(
      checkLimits(DEFAULT_TIER_LIMITS.new, { instances: 0 }, product({ windows: true })),
    ).toEqual(limit("windows"));
    expect(
      checkLimits(DEFAULT_TIER_LIMITS.trusted, { instances: 0 }, product({ windows: true })).ok,
    ).toBe(true);
  });

  it("refuses too many static IPs", () => {
    expect(
      checkLimits(DEFAULT_TIER_LIMITS.new, { instances: 0 }, product({ staticIps: 2 })),
    ).toEqual(limit("static_ips"));
  });

  it("fails closed on a bundle price that is not a plain decimal", () => {
    expect(() =>
      checkLimits(DEFAULT_TIER_LIMITS.new, { instances: 0 }, product({ bundleUsd: "abc" })),
    ).toThrow(RangeError);
  });
});
