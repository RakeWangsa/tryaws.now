import type { CatalogProduct } from "@tc/db";
import { describe, expect, it } from "vitest";
import { parseContainerConfig, resolveContainer } from "./container";
import { resolveProduct } from "./instance";

const PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: PID,
  family: "container_service",
  awsId: "micro",
  platform: null,
  region: "ap-southeast-1",
  specs: { scale: 2 },
  awsPriceUsd: "20.0000",
  billingUnit: "month",
  featureFlag: "container_service",
  active: true,
  ...over,
});
const raw = { productId: PID, region: "ap-southeast-1", displayName: "Web app" };

describe("resolveContainer (the order seam of a container service)", () => {
  it("needs one container service slot and keeps three fields in the config", () => {
    const parsed = parseContainerConfig({ ...raw, image: "nginx", registry: "x" });
    if (!parsed.ok) throw new Error("parse");
    expect(resolveContainer(parsed.value, row())).toMatchObject({
      ok: true,
      value: {
        family: "container_service",
        featureFlag: "container_service",
        awsPriceUsd: "20.0000",
        needs: [{ quotaCode: "container_service", amount: 1 }],
        resourceConfig: raw,
      },
    });
  });

  it("is unavailable when the row is inactive, of another family or Region, or has no valid power and scale", () => {
    const parsed = parseContainerConfig(raw);
    if (!parsed.ok) throw new Error("parse");
    for (const bad of [
      row({ active: false }),
      row({ family: "bucket" }),
      row({ region: "eu-west-1" }),
      row({ awsId: "gigantic" }),
      row({ specs: {} }),
      row({ specs: { scale: 21 } }),
      row({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    ]) {
      expect(resolveContainer(parsed.value, bad)).toEqual({
        ok: false,
        error: "validation",
        fields: { productId: "unavailable" },
      });
    }
  });

  it("resolveProduct knows the family and fails closed", async () => {
    expect((await resolveProduct("container_service", raw, async () => row())).ok).toBe(true);
    expect((await resolveProduct("container_service", raw, async () => null)).ok).toBe(false);
  });
});
