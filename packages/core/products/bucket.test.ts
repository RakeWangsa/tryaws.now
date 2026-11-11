import { describe, expect, it } from "vitest";
import { parseBucketAccess, parseBucketConfig } from "./bucket";

const PRODUCT_ID = "0190bbbb-0000-7000-8000-000000000001";
const GOOD = { productId: PRODUCT_ID, region: "ap-south-1", displayName: "Photos 2026" };

describe("parseBucketConfig", () => {
  it("keeps the three known fields and drops everything else (R11)", () => {
    const r = parseBucketConfig({ ...GOOD, awsName: "tc-bucket-x", bucketName: "evil", extra: 1 });
    expect(r).toEqual({ ok: true, value: GOOD });
  });
  it("refuses a bad product id, region or display name", () => {
    const r = parseBucketConfig({ productId: "x", region: "mars", displayName: "<b>" });
    expect(r).toMatchObject({
      ok: false,
      error: "validation",
      fields: { productId: "invalid", region: "invalid", displayName: "invalid" },
    });
  });
});

describe("parseBucketAccess", () => {
  it("accepts private and public, never lets objects override to public", () => {
    expect(parseBucketAccess({ mode: "private" })).toEqual({
      getObject: "private",
      allowPublicOverrides: false,
    });
    expect(parseBucketAccess({ mode: "public" })).toEqual({
      getObject: "public",
      allowPublicOverrides: false,
    });
  });
  it("refuses anything else", () => {
    for (const bad of [null, {}, { mode: "owner" }, { mode: "Private" }, "private", []]) {
      expect(parseBucketAccess(bad)).toBeNull();
    }
  });
});
