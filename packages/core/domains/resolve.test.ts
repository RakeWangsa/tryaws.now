import { describe, expect, it } from "vitest";
import { parseDomainConfig, resolveDomain, type TldProduct } from "./resolve";

const TLD_ID = "11111111-1111-4111-8111-111111111111";
const SEALED = Buffer.from("sealed-envelope-bytes").toString("base64");

const COM: TldProduct = {
  id: TLD_ID,
  tld: "com",
  registrationPriceUsd: "13.0000",
  renewalPriceUsd: "15.0000",
  needsExtraParams: false,
};

const config = { productId: TLD_ID, name: "example.com", contactSealed: SEALED };

describe("parseDomainConfig", () => {
  it("keeps three fields and drops everything else (R11)", () => {
    const r = parseDomainConfig({ ...config, awsName: "tc-x", capacityReservation: {}, extra: 1 });
    expect(r).toEqual({ ok: true, value: config });
  });
  it("collects every invalid field", () => {
    const r = parseDomainConfig({ productId: "x", name: "", contactSealed: "not base64!" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fields).toEqual({
        productId: "invalid",
        name: "invalid",
        contactSealed: "invalid",
      });
    }
  });
});

describe("resolveDomain", () => {
  it("prices the registration per year from the TLD row and takes no capacity", () => {
    const r = resolveDomain(config, COM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      family: "domain",
      productId: TLD_ID,
      region: "us-east-1",
      featureFlag: "domain",
      awsPriceUsd: "13.0000",
      quantity: "1",
      needs: [],
    });
    expect(r.value.resourceConfig).toMatchObject({
      name: "example.com",
      tld: "com",
      review: false,
    });
  });
  it("marks a TLD with extra parameters for admin review", () => {
    const r = resolveDomain(
      { ...config, name: "example.ai" },
      { ...COM, tld: "ai", needsExtraParams: true },
    );
    expect(r.ok && r.value.resourceConfig["review"]).toBe(true);
  });
  it("refuses another row, an unpriced TLD and a name outside the TLD", () => {
    expect(resolveDomain({ ...config, productId: TLD_ID.replace("1", "2") }, COM).ok).toBe(false);
    expect(resolveDomain(config, { ...COM, registrationPriceUsd: null }).ok).toBe(false);
    expect(resolveDomain(config, { ...COM, renewalPriceUsd: null }).ok).toBe(false);
    expect(resolveDomain({ ...config, name: "example.net" }, COM).ok).toBe(false);
    expect(resolveDomain({ ...config, name: "Example.com" }, COM).ok).toBe(false);
    expect(resolveDomain({ ...config, name: "a.b.com" }, COM).ok).toBe(false);
  });
  it("holds the sealed contact and no plain contact text", () => {
    const r = resolveDomain(config, COM);
    expect(r.ok && JSON.stringify(r.value.resourceConfig)).not.toMatch(/@|\+880/);
  });
});
