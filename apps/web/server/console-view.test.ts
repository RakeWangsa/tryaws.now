import { describe, expect, it } from "vitest";
import {
  bucketVersioningOf,
  cachePolicyFactsOf,
  certificateFactsOf,
  databaseConsoleOf,
  deploymentHistoryOf,
  loadBalancerConsoleOf,
  planFactsOf,
} from "./console-view.ts";

describe("loadBalancerConsoleOf", () => {
  it("reads the fields the adapter wrote, and nothing else", () => {
    const out = loadBalancerConsoleOf({
      displayName: "x",
      awsName: "tc-lb-0123456789abcdef",
      healthCheckPath: "/health.html",
      httpsRedirect: true,
      certificate: {
        domain: "shop.example.com",
        status: "PENDING_VALIDATION",
        attached: false,
        arn: "arn:aws:lightsail:secret",
        records: [{ name: "_a.shop.example.com.", type: "CNAME", value: "_b.acm.", extra: 1 }],
      },
    });
    expect(out).toEqual({
      healthCheckPath: "/health.html",
      httpsRedirect: true,
      certificate: {
        domain: "shop.example.com",
        status: "PENDING_VALIDATION",
        attached: false,
        records: [{ name: "_a.shop.example.com.", type: "CNAME", value: "_b.acm." }],
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/arn:|tc-lb-/);
  });

  it("fails closed on a missing or malformed config", () => {
    for (const bad of [
      null,
      undefined,
      5,
      "x",
      [],
      {},
      { certificate: "x", httpsRedirect: "yes" },
    ]) {
      expect(loadBalancerConsoleOf(bad)).toEqual({
        healthCheckPath: null,
        httpsRedirect: null,
        certificate: null,
      });
    }
    expect(loadBalancerConsoleOf({ certificate: { status: "<script>" } }).certificate?.status).toBe(
      "UNKNOWN",
    );
  });
});

describe("databaseConsoleOf and bucketVersioningOf", () => {
  it("default to private, no window and unknown versioning", () => {
    expect(databaseConsoleOf({})).toEqual({ backupWindow: null, publiclyAccessible: false });
    expect(databaseConsoleOf({ backupWindow: "16:00-16:30", publiclyAccessible: true })).toEqual({
      backupWindow: "16:00-16:30",
      publiclyAccessible: true,
    });
    expect(databaseConsoleOf({ publiclyAccessible: "true" }).publiclyAccessible).toBe(false);
    expect(bucketVersioningOf({})).toBeNull();
    expect(bucketVersioningOf({ versioning: "Enabled" })).toBe("Enabled");
    expect(bucketVersioningOf({ versioning: "on" })).toBeNull();
  });
});

describe("planFactsOf (WPU-G8)", () => {
  const A = "0190aaaa-0000-7000-8000-0000000000c1";
  const B = "0190aaaa-0000-7000-8000-0000000000c2";
  it("reads the plan in force and the pending plan; a bad id is no plan", () => {
    expect(planFactsOf({ productId: A, pendingPlan: { productId: B } }, null)).toEqual({
      currentProductId: A,
      pendingProductId: B,
    });
    expect(planFactsOf({}, B)).toEqual({ currentProductId: B, pendingProductId: null });
    expect(planFactsOf({ productId: "x", pendingPlan: { productId: "../etc" } }, null)).toEqual({
      currentProductId: null,
      pendingProductId: null,
    });
    expect(planFactsOf({ pendingPlan: "nope" }, A).pendingProductId).toBeNull();
  });
});

describe("certificateFactsOf", () => {
  it("is null for none or odd, and reads the records field by field", () => {
    for (const odd of [undefined, null, 5, "x", []]) expect(certificateFactsOf(odd)).toBeNull();
    const out = certificateFactsOf({
      domain: "a.example.com",
      status: "ISSUED",
      attached: true,
      arn: "arn:aws:lightsail:x",
      records: [{ name: "n", type: "CNAME", value: "v", extra: "x" }],
    });
    expect(out).toEqual({
      domain: "a.example.com",
      status: "ISSUED",
      attached: true,
      records: [{ name: "n", type: "CNAME", value: "v" }],
    });
    expect(JSON.stringify(out)).not.toContain("arn:");
    expect(certificateFactsOf({ status: "WEIRD" })?.status).toBe("UNKNOWN");
  });
});

describe("cachePolicyFactsOf", () => {
  it("reads a saved policy again by the same rules and drops one that does not hold", () => {
    const saved = {
      defaultBehavior: "cache",
      settings: {
        defaultTtl: 60,
        minimumTtl: 0,
        maximumTtl: 120,
        allowedHttpMethods: "GET,HEAD",
        cachedHttpMethods: "GET,HEAD",
        cookies: "none",
        headers: "none",
        queryStrings: true,
      },
      paths: [{ path: "a/*", behavior: "dont-cache" }],
    };
    expect(cachePolicyFactsOf({ cachePolicy: saved })).toMatchObject({
      defaultTtl: 60,
      queryStrings: true,
      paths: [{ path: "a/*", behavior: "dont-cache" }],
    });
    expect(cachePolicyFactsOf({})).toBeNull();
    expect(cachePolicyFactsOf({ cachePolicy: { ...saved, defaultBehavior: "x" } })).toBeNull();
  });
});

describe("deploymentHistoryOf", () => {
  it("returns at most ten entries, newest first, with images and no other field", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({
      at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      images: [`img${i}`],
      endpoint: i % 2 === 0,
      environment: { SECRET: "s3cr3t" },
    }));
    const out = deploymentHistoryOf({ deployments: list });
    expect(out).toHaveLength(10);
    expect(out[0]?.images).toEqual(["img11"]);
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    expect(deploymentHistoryOf({ deployments: [{ at: "nope", images: [] }, 5, null] })).toEqual([]);
    expect(deploymentHistoryOf({})).toEqual([]);
  });
});
