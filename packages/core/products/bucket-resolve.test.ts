import type { CatalogProduct } from "@tc/db";
import { describe, expect, it } from "vitest";
import { parseBucketConfig, resolveBucket } from "./bucket";
import { resolveProduct } from "./instance";

const PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: PID,
  family: "bucket",
  awsId: "small_1_0",
  platform: null,
  region: "ap-southeast-1",
  specs: {},
  awsPriceUsd: "5.0000",
  billingUnit: "month",
  featureFlag: "bucket",
  active: true,
  ...over,
});
const raw = { productId: PID, region: "ap-southeast-1", displayName: "Site assets" };

describe("resolveBucket (the order seam of an object storage bucket)", () => {
  it("needs one bucket slot, keeps three fields in the config and holds no access setting", () => {
    const parsed = parseBucketConfig({ ...raw, awsName: "evil", access: "public" });
    if (!parsed.ok) throw new Error("parse");
    const r = resolveBucket(parsed.value, row());
    expect(r).toMatchObject({
      ok: true,
      value: {
        family: "bucket",
        productId: PID,
        featureFlag: "bucket",
        awsPriceUsd: "5.0000",
        needs: [{ quotaCode: "bucket", amount: 1 }],
        resourceConfig: raw,
      },
    });
  });

  it("is unavailable when the row is inactive, of another family or Region, or another product", () => {
    const parsed = parseBucketConfig(raw);
    if (!parsed.ok) throw new Error("parse");
    for (const bad of [
      row({ active: false }),
      row({ family: "linux_instance" }),
      row({ region: "eu-west-1" }),
      row({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    ]) {
      expect(resolveBucket(parsed.value, bad)).toEqual({
        ok: false,
        error: "validation",
        fields: { productId: "unavailable" },
      });
    }
  });

  it("resolveProduct knows the family and fails closed on a missing row", async () => {
    expect((await resolveProduct("bucket", raw, async () => row())).ok).toBe(true);
    expect(await resolveProduct("bucket", raw, async () => null)).toMatchObject({
      ok: false,
      fields: { productId: "unavailable" },
    });
    expect(
      await resolveProduct("bucket", { ...raw, displayName: "a;b" }, async () => row()),
    ).toMatchObject({ ok: false, fields: { displayName: "invalid" } });
  });
});
