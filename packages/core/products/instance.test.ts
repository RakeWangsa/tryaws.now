import type { CatalogProduct } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { parseInstanceConfig, resolveInstance, resolveProduct } from "./instance";

const PRODUCT_ID = "0190bbbb-0000-7000-8000-000000000001";
const KEY_ID = "0190bbbb-0000-7000-8000-000000000002";

function product(over: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: PRODUCT_ID,
    family: "linux_instance",
    awsId: "small_3_0",
    platform: "linux",
    region: "ap-south-1",
    specs: { vcpus: 2, ramGb: 2 },
    awsPriceUsd: "12.0000",
    billingUnit: "month",
    featureFlag: "linux_instance",
    active: true,
    ...over,
  };
}
const GOOD = { productId: PRODUCT_ID, region: "ap-south-1", displayName: "My server-1.a_b" };

describe("parseInstanceConfig", () => {
  it("accepts a good config and fills keyPairId with null", () => {
    expect(parseInstanceConfig(GOOD)).toEqual({
      ok: true,
      value: { ...GOOD, keyPairId: null },
    });
    expect(parseInstanceConfig({ ...GOOD, keyPairId: KEY_ID })).toEqual({
      ok: true,
      value: { ...GOOD, keyPairId: KEY_ID },
    });
  });

  it("reports every invalid field at once, with fixed words", () => {
    const r = parseInstanceConfig({
      productId: "nope",
      region: "Mars",
      displayName: "<script>",
      keyPairId: 7,
    });
    expect(r).toEqual({
      ok: false,
      error: "validation",
      fields: {
        productId: "invalid",
        region: "invalid",
        displayName: "invalid",
        keyPairId: "invalid",
      },
    });
  });

  it("reports missing fields and a non-object input", () => {
    expect(parseInstanceConfig({})).toEqual({
      ok: false,
      error: "validation",
      fields: { productId: "invalid", region: "invalid", displayName: "invalid" },
    });
    for (const raw of [null, undefined, "x", 3, []]) {
      expect(parseInstanceConfig(raw).ok).toBe(false);
    }
  });

  it("bounds the display name to 1..60 allowed characters", () => {
    expect(parseInstanceConfig({ ...GOOD, displayName: "a" }).ok).toBe(true);
    expect(parseInstanceConfig({ ...GOOD, displayName: "a".repeat(60) }).ok).toBe(true);
    expect(parseInstanceConfig({ ...GOOD, displayName: "a".repeat(61) }).ok).toBe(false);
    expect(parseInstanceConfig({ ...GOOD, displayName: "" }).ok).toBe(false);
    expect(parseInstanceConfig({ ...GOOD, displayName: "bad\nname" }).ok).toBe(false);
    expect(parseInstanceConfig({ ...GOOD, displayName: "বাংলা" }).ok).toBe(false);
  });

  it("drops unknown keys, capacityReservation and awsName; never copies them", () => {
    const r = parseInstanceConfig({
      ...GOOD,
      capacityReservation: { v: 1, poolAccountId: "x", cells: [] },
      awsName: "tc-instance-1",
      extra: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual([
        "displayName",
        "keyPairId",
        "productId",
        "region",
      ]);
    }
  });
});

describe("resolveInstance", () => {
  const config = { ...GOOD, keyPairId: null };

  it("resolves a Linux product with the vCPUs and its static IP as needs", () => {
    const r = resolveInstance(config, product());
    expect(r).toEqual({
      ok: true,
      value: {
        family: "linux_instance",
        productId: PRODUCT_ID,
        region: "ap-south-1",
        featureFlag: "linux_instance",
        awsPriceUsd: "12.0000",
        facts: { bundleUsd: "12.0000", windows: false, staticIps: 1 },
        needs: [
          { quotaCode: "instance_vcpu", amount: 2 },
          { quotaCode: "static_ip", amount: 1 },
        ],
        resourceConfig: {
          productId: PRODUCT_ID,
          region: "ap-south-1",
          displayName: "My server-1.a_b",
          keyPairId: null,
        },
      },
    });
  });

  const windows = (over: Partial<CatalogProduct> = {}) =>
    product({
      family: "windows_instance",
      platform: "windows",
      featureFlag: "windows_instance",
      ...over,
    });

  it("resolves a Windows product under its own family, flag and the windows fact", () => {
    const r = resolveInstance(config, windows());
    expect(r).toMatchObject({
      ok: true,
      value: {
        family: "windows_instance",
        featureFlag: "windows_instance",
        facts: { bundleUsd: "12.0000", windows: true, staticIps: 1 },
        needs: [
          { quotaCode: "instance_vcpu", amount: 2 },
          { quotaCode: "static_ip", amount: 1 },
        ],
      },
    });
  });

  it("never stores a customer key for Windows: the pool default key pair is used (10.3)", () => {
    const r = resolveInstance({ ...config, keyPairId: KEY_ID }, windows());
    expect(r.ok && r.value.resourceConfig.keyPairId).toBe(null);
  });

  it("refuses a platform that does not match the family (R16)", () => {
    const unavailable = { ok: false, error: "validation", fields: { productId: "unavailable" } };
    expect(resolveInstance(config, product({ platform: "windows" }))).toEqual(unavailable);
    expect(resolveInstance(config, windows({ platform: "linux" }))).toEqual(unavailable);
  });

  it("stores the validated config, never the raw input", () => {
    const parsed = parseInstanceConfig({ ...GOOD, capacityReservation: { v: 1 } });
    if (!parsed.ok) throw new Error("setup");
    const r = resolveInstance(parsed.value, product());
    expect(r.ok && "capacityReservation" in r.value.resourceConfig).toBe(false);
  });

  const unavailable = { ok: false, error: "validation", fields: { productId: "unavailable" } };
  it.each([
    ["an inactive product", { active: false }],
    ["another family", { family: "database" }],
    ["another Region", { region: "ap-southeast-1" }],
    ["specs without vcpus", { specs: {} }],
    ["vcpus zero", { specs: { vcpus: 0 } }],
    ["vcpus a fraction", { specs: { vcpus: 1.5 } }],
    ["vcpus text", { specs: { vcpus: "2" } }],
    ["specs null", { specs: null }],
    ["an unknown platform", { platform: "macos" }],
    ["a null platform", { platform: null }],
  ] as [string, Partial<CatalogProduct>][])("refuses %s", (_, over) => {
    expect(resolveInstance(config, product(over))).toEqual(unavailable);
  });

  it("refuses a product whose id differs from the config", () => {
    expect(resolveInstance(config, product({ id: KEY_ID }))).toEqual(unavailable);
  });
});

describe("resolveProduct", () => {
  it("is unsupported for every family but instance, without loading anything", async () => {
    const load = vi.fn();
    for (const family of ["disk", "static_ip", "instance", ""]) {
      expect(await resolveProduct(family, GOOD, load)).toEqual({
        ok: false,
        error: "validation",
        fields: { family: "unsupported" },
      });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("does not load when the config is invalid", async () => {
    const load = vi.fn();
    const r = await resolveProduct("linux_instance", { productId: "x" }, load);
    expect(r.ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("is unavailable when the product is not in the catalog", async () => {
    const load = vi.fn().mockResolvedValue(null);
    expect(await resolveProduct("linux_instance", GOOD, load)).toEqual({
      ok: false,
      error: "validation",
      fields: { productId: "unavailable" },
    });
    expect(load).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it("resolves a loaded product", async () => {
    const r = await resolveProduct("linux_instance", GOOD, async () => product());
    expect(r.ok).toBe(true);
  });

  it("resolves a Windows product only for the family windows_instance", async () => {
    const win = product({ family: "windows_instance", platform: "windows" });
    const ok = await resolveProduct("windows_instance", GOOD, async () => win);
    expect(ok.ok && ok.value.family).toBe("windows_instance");
    // The family asked for and the family of the row must agree.
    expect((await resolveProduct("linux_instance", GOOD, async () => win)).ok).toBe(false);
    expect((await resolveProduct("windows_instance", GOOD, async () => product())).ok).toBe(false);
  });

  it("does not load when a Windows config is invalid", async () => {
    const load = vi.fn();
    expect((await resolveProduct("windows_instance", {}, load)).ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
