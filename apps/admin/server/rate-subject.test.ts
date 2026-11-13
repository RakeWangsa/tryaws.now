import { describe, expect, it } from "vitest";
import { envLinks } from "@tc/db/links";
import { LOCAL_TEST_ONLY_RATE_KEY, rateSubject, resolveRateKey } from "./rate-subject.ts";

const KEY = "k".repeat(40);
const withSecret = (extra: Record<string, string | undefined> = {}) => ({
  TC_STAGE: "staging",
  SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: KEY }),
  ...extra,
});

// The key of these tests comes from the SST_RESOURCE_<Name> variables of the environment object
// (envLinks); the run-time path through the SST SDK is rate-subject-sst.test.ts (WPU-Z15).
const resolve = (env: Record<string, string | undefined>) => resolveRateKey(env, envLinks(env));

describe("resolveRateKey (R3, R16)", () => {
  it("reads the linked secret in a deployed stage", () => {
    expect(resolve(withSecret())).toBe(KEY);
    expect(resolve(withSecret({ TC_STAGE: "production" }))).toBe(KEY);
  });
  it("fails closed when the secret is missing, malformed or short in a deployed stage", () => {
    for (const stage of ["staging", "production", "", undefined]) {
      expect(() => resolve({ TC_STAGE: stage })).toThrow();
    }
    expect(() => resolve(withSecret({ SST_RESOURCE_AdminIpLimitKey: "not json" }))).toThrow();
    expect(() =>
      resolve(withSecret({ SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: "short" }) })),
    ).toThrow();
  });
  it("uses the named fallback only in local and test", () => {
    expect(resolve({ TC_STAGE: "local" })).toBe(LOCAL_TEST_ONLY_RATE_KEY);
    expect(resolve({ TC_STAGE: "test" })).toBe(LOCAL_TEST_ONLY_RATE_KEY);
    expect(resolve(withSecret({ TC_STAGE: "local" }))).toBe(KEY);
  });
  it("never throws a message that holds the key", () => {
    try {
      resolve(withSecret({ SST_RESOURCE_AdminIpLimitKey: JSON.stringify({ value: "short" }) }));
    } catch (e) {
      expect(String(e)).not.toContain("short");
    }
  });
});

describe("resolveRateKey with its default links, the SST SDK (WPU-Z15)", () => {
  it("nothing linked: the fixed refusal in a deployed stage, not the error of the SDK", () => {
    // The SDK's own Resource throws for a name that is not linked (packages/db/test/links.test.ts); the
    // reader must not pass it on.
    for (const stage of ["staging", "production", undefined]) {
      expect(() => resolveRateKey({ TC_STAGE: stage })).toThrow(
        /^admin: rate-limit key is not available$/,
      );
    }
    expect(resolveRateKey({ TC_STAGE: "test" })).toBe(LOCAL_TEST_ONLY_RATE_KEY);
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
