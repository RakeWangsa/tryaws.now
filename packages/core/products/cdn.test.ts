import { describe, expect, it } from "vitest";
import { resolveProduct } from "./instance";
import {
  CDN_BUNDLES,
  CDN_ORIGIN_FAMILIES,
  cdnBundleFrom,
  cdnDefaultDomain,
  checkCdnOrigin,
  parseCdnConfig,
  resolveCdn,
  type OriginCandidate,
} from "./cdn";

const ME = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "22222222-2222-4222-8222-222222222222";
const cand = (over: Partial<OriginCandidate> = {}): OriginCandidate => ({
  id: ORIGIN,
  customerId: ME,
  family: "linux_instance",
  state: "active",
  ...over,
});
const check = (candidate: OriginCandidate | null, requested = ORIGIN) =>
  checkCdnOrigin({ customerId: ME, requested, candidate });

describe("parseCdnConfig", () => {
  const input = {
    productId: PRODUCT,
    region: "us-east-1",
    displayName: "Site CDN",
    originId: ORIGIN,
    cacheBehavior: "dont-cache",
  };

  it("keeps the known fields and drops a domain, a certificate, awsName and unknown keys (R11)", () => {
    const r = parseCdnConfig({
      ...input,
      domain: "shop.example.com",
      certificateName: "x",
      alternativeDomainNames: ["a.example.com"],
      awsName: "tc-cdn-0000",
      extra: 1,
    });
    expect(r).toEqual({ ok: true, value: input });
  });

  it("caches by default", () => {
    const rest: Record<string, unknown> = { ...input };
    delete rest.cacheBehavior;
    expect(parseCdnConfig(rest)).toMatchObject({ ok: true, value: { cacheBehavior: "cache" } });
  });

  it("collects every invalid field and nothing else", () => {
    expect(
      parseCdnConfig({
        productId: "x",
        region: "r",
        displayName: "<b>",
        originId: "no",
        cacheBehavior: "everything",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: {
        productId: "invalid",
        region: "invalid",
        displayName: "invalid",
        originId: "invalid",
        cacheBehavior: "invalid",
      },
    });
    expect(parseCdnConfig(null)).toMatchObject({ ok: false, error: "validation" });
    expect(parseCdnConfig({ ...input, originId: undefined })).toMatchObject({
      ok: false,
      fields: { originId: "invalid" },
    });
  });
});

describe("checkCdnOrigin (pure)", () => {
  it("accepts the customer's own active server, load balancer or bucket", () => {
    for (const family of CDN_ORIGIN_FAMILIES) {
      expect(check(cand({ family }))).toEqual({ ok: true, value: ORIGIN });
    }
    expect([...CDN_ORIGIN_FAMILIES].sort()).toEqual([
      "bucket",
      "linux_instance",
      "load_balancer",
      "windows_instance",
    ]);
  });

  it("another customer's resource gives the same answer as a missing one (R8)", () => {
    const foreign = check(cand({ customerId: OTHER }));
    expect(foreign).toEqual(check(null));
    expect(foreign).toEqual({ ok: false, error: "validation", fields: { originId: "invalid" } });
  });

  it("refuses a family that is no origin, a state that is not active and a mismatched id", () => {
    for (const family of ["database", "container_service", "cdn", "dns", "disk", "backup"]) {
      expect(check(cand({ family })).ok, family).toBe(false);
    }
    for (const state of ["creating", "stopped", "suspended", "destroyed", "failed"]) {
      expect(check(cand({ state })).ok, state).toBe(false);
    }
    expect(check(cand({ id: PRODUCT })).ok).toBe(false);
    expect(check(cand(), "not-a-uuid").ok).toBe(false);
  });
});

describe("cdnBundleFrom", () => {
  it("accepts the Lightsail distribution bundles and nothing else (R16)", () => {
    expect([...CDN_BUNDLES]).toEqual(["small_1_0", "medium_1_0", "large_1_0"]);
    expect(cdnBundleFrom("small_1_0")).toBe("small_1_0");
    for (const bad of ["nano_3_0", "", null, undefined, 3, "small_1_0 "]) {
      expect(cdnBundleFrom(bad)).toBeNull();
    }
  });
});

describe("resolveCdn takes only a checked origin", () => {
  const row = {
    id: PRODUCT,
    family: "cdn",
    awsId: "small_1_0",
    platform: null,
    region: "us-east-1",
    specs: {},
    awsPriceUsd: "5.0000",
    billingUnit: "month",
    featureFlag: "cdn",
    active: true,
  };
  const config = {
    productId: PRODUCT,
    region: "us-east-1",
    displayName: "Site CDN",
    originId: OTHER,
    cacheBehavior: "cache" as const,
  };
  const checked = (() => {
    const r = check(cand());
    if (!r.ok) throw new Error("check");
    return r.value;
  })();

  it("writes the checked origin id, needs one distribution and the cdn flag", () => {
    expect(resolveCdn(config, row, checked)).toEqual({
      ok: true,
      value: {
        family: "cdn",
        productId: PRODUCT,
        region: "us-east-1",
        featureFlag: "cdn",
        awsPriceUsd: "5.0000",
        facts: { bundleUsd: "5.0000", windows: false, staticIps: 0 },
        needs: [{ quotaCode: "distribution", amount: 1 }],
        resourceConfig: {
          productId: PRODUCT,
          region: "us-east-1",
          displayName: "Site CDN",
          originId: ORIGIN,
          cacheBehavior: "cache",
        },
      },
    });
  });

  it("refuses a product of another family, another Region, an inactive row or another id", () => {
    const unavailable = { ok: false, error: "validation", fields: { productId: "unavailable" } };
    expect(resolveCdn(config, { ...row, family: "bucket" }, checked)).toEqual(unavailable);
    expect(resolveCdn(config, { ...row, region: "ap-south-1" }, checked)).toEqual(unavailable);
    expect(resolveCdn(config, { ...row, active: false }, checked)).toEqual(unavailable);
    expect(resolveCdn(config, { ...row, id: OTHER }, checked)).toEqual(unavailable);
    expect(resolveCdn(config, { ...row, awsId: "huge_9_9" }, checked)).toEqual(unavailable);
  });

  it("resolveProduct does not know the family: the order path checks the origin first", async () => {
    expect(await resolveProduct("cdn", config, async () => row)).toEqual({
      ok: false,
      error: "validation",
      fields: { family: "unsupported" },
    });
  });
});

describe("cdnDefaultDomain", () => {
  it("keeps a plain host name, which the customer needs in order to use the distribution (U6)", () => {
    expect(cdnDefaultDomain("d1a2b3c4d5e6f7.cloudfront.net")).toBe("d1a2b3c4d5e6f7.cloudfront.net");
  });

  it("drops anything that is not a plain host name, so it can never become markup or a URL", () => {
    for (const bad of [
      "",
      "https://d1.cloudfront.net",
      "d1.cloudfront.net/path",
      "<b>x</b>.example.com",
      "a b.example.com",
      "localhost",
      "-bad.example.com",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(130)}com`,
      null,
      undefined,
      42,
    ]) {
      expect(cdnDefaultDomain(bad), String(bad)).toBeNull();
    }
  });
});
