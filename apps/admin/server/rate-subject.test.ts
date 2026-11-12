import { describe, expect, it } from "vitest";
import { LOCAL_TEST_ONLY_RATE_KEY, rateSubject, resolveRateKey } from "./rate-subject.ts";

const KEY = "k".repeat(40);
const withSecret = (extra: Record<string, string | undefined> = {}) => ({
  TC_STAGE: "staging",
  SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: KEY }),
  ...extra,
});

describe("resolveRateKey (R3, R16)", () => {
  it("reads the linked secret in a deployed stage", () => {
    expect(resolveRateKey(withSecret())).toBe(KEY);
    expect(resolveRateKey(withSecret({ TC_STAGE: "production" }))).toBe(KEY);
  });
  it("fails closed when the secret is missing, malformed or short in a deployed stage", () => {
    for (const stage of ["staging", "production", "", undefined]) {
      expect(() => resolveRateKey({ TC_STAGE: stage })).toThrow();
    }
    expect(() =>
      resolveRateKey(withSecret({ SST_RESOURCE_AdminIpLimitKey: "not json" })),
    ).toThrow();
    expect(() =>
      resolveRateKey(
        withSecret({ SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: "short" }) }),
      ),
    ).toThrow();
  });
  it("uses the named fallback only in local and test", () => {
    expect(resolveRateKey({ TC_STAGE: "local" })).toBe(LOCAL_TEST_ONLY_RATE_KEY);
    expect(resolveRateKey({ TC_STAGE: "test" })).toBe(LOCAL_TEST_ONLY_RATE_KEY);
    expect(resolveRateKey(withSecret({ TC_STAGE: "local" }))).toBe(KEY);
  });
  it("never throws a message that holds the key", () => {
    try {
      resolveRateKey(
        withSecret({ SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: "short" }) }),
      );
    } catch (e) {
      expect(String(e)).not.toContain("short");
    }
  });
});

describe("rateSubject (R14)", () => {
  it("is deterministic, hex, never holds the raw address", () => {
    const a = rateSubject(KEY, "203.0.113.7");
    expect(a).toBe(rateSubject(KEY, "203.0.113.7"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203.0.113.7");
  });
  it("depends on the key and on the address", () => {
    expect(rateSubject(KEY, "203.0.113.7")).not.toBe(rateSubject("z".repeat(40), "203.0.113.7"));
    expect(rateSubject(KEY, "203.0.113.7")).not.toBe(rateSubject(KEY, "203.0.113.8"));
  });
});
