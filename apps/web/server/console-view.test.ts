import { describe, expect, it } from "vitest";
import { bucketVersioningOf, databaseConsoleOf, loadBalancerConsoleOf } from "./console-view.ts";

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
    expect(databaseConsoleOf({})).toEqual({
      backupWindow: null,
      maintenanceWindow: null,
      publiclyAccessible: false,
    });
    expect(databaseConsoleOf({ backupWindow: "16:00-16:30", publiclyAccessible: true })).toEqual({
      backupWindow: "16:00-16:30",
      maintenanceWindow: null,
      publiclyAccessible: true,
    });
    expect(databaseConsoleOf({ publiclyAccessible: "true" }).publiclyAccessible).toBe(false);
    expect(bucketVersioningOf({})).toBeNull();
    expect(bucketVersioningOf({ versioning: "Enabled" })).toBe("Enabled");
    expect(bucketVersioningOf({ versioning: "on" })).toBeNull();
  });
});
