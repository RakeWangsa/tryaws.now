import type { CatalogProduct } from "@tc/db";
import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, resolveDatabase } from "./database";
import { resolveProduct } from "./instance";

const PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: PID,
  family: "database",
  awsId: "micro_2_0",
  platform: null,
  region: "ap-southeast-1",
  specs: {},
  awsPriceUsd: "15.0000",
  billingUnit: "month",
  featureFlag: "database",
  active: true,
  ...over,
});
const raw = { productId: PID, region: "ap-southeast-1", displayName: "Orders DB" };

describe("database config and product", () => {
  it("parses the three known fields and drops the rest, publicly accessible included", () => {
    const r = parseDatabaseConfig({ ...raw, publiclyAccessible: true, masterUserPassword: "x" });
    expect(r).toEqual({ ok: true, value: raw });
  });
  it("refuses a bad display name", () => {
    expect(parseDatabaseConfig({ ...raw, displayName: "a;b" }).ok).toBe(false);
  });
  it("needs one database slot, and a config that holds no secret", () => {
    const parsed = parseDatabaseConfig(raw);
    if (!parsed.ok) throw new Error("parse");
    const r = resolveDatabase(parsed.value, row());
    expect(r).toMatchObject({
      ok: true,
      value: { family: "database", needs: [{ quotaCode: "database", amount: 1 }] },
    });
    expect(JSON.stringify(r)).not.toMatch(/pass/i);
  });
  it("is unavailable when inactive, in another family or another Region", async () => {
    const parsed = parseDatabaseConfig(raw);
    if (!parsed.ok) throw new Error("parse");
    for (const bad of [
      row({ active: false }),
      row({ family: "linux_instance" }),
      row({ region: "eu-west-1" }),
    ]) {
      expect(resolveDatabase(parsed.value, bad).ok).toBe(false);
    }
    expect((await resolveProduct("database", raw, async () => row())).ok).toBe(true);
  });
});
