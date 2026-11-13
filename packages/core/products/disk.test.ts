import { describe, expect, it } from "vitest";
import { checkDiskServer, MAX_DISK_GB, MIN_DISK_GB, parseDiskConfig, resolveDisk } from "./disk";

const PRODUCT_ID = "0190bbbb-0000-7000-8000-000000000001";
const SERVER_ID = "0190bbbb-0000-7000-8000-000000000002";
const GOOD = {
  productId: PRODUCT_ID,
  region: "ap-south-1",
  displayName: "Data 1",
  sizeGb: 100,
  serverId: SERVER_ID,
};

const ANCHOR = {
  id: PRODUCT_ID,
  family: "disk",
  awsId: "block-storage-gb",
  platform: null,
  region: "ap-south-1",
  specs: { unit: "gb" },
  awsPriceUsd: "0.1000",
  billingUnit: "gb_month",
  featureFlag: "disk",
  active: true,
} as const;

describe("parseDiskConfig", () => {
  it("keeps the five known fields and drops everything else (R11)", () => {
    const r = parseDiskConfig({ ...GOOD, awsName: "tc-disk-x", extra: 1, capacityReservation: {} });
    expect(r).toEqual({ ok: true, value: GOOD });
  });

  it("collects every invalid field", () => {
    const r = parseDiskConfig({
      productId: "x",
      region: "mars",
      displayName: "<b>",
      sizeGb: 1.5,
      serverId: "y",
    });
    expect(r).toMatchObject({
      ok: false,
      error: "validation",
      fields: {
        productId: "invalid",
        region: "invalid",
        displayName: "invalid",
        sizeGb: "invalid",
        serverId: "invalid",
      },
    });
  });

  it("accepts the size limits of the adapter and nothing outside them", () => {
    expect(parseDiskConfig({ ...GOOD, sizeGb: MIN_DISK_GB }).ok).toBe(true);
    expect(MAX_DISK_GB).toBe(16_000);
    expect(MIN_DISK_GB).toBe(8);
    expect(parseDiskConfig({ ...GOOD, sizeGb: MAX_DISK_GB }).ok).toBe(true);
    for (const sizeGb of [MIN_DISK_GB - 1, MAX_DISK_GB + 1, 0, -8, 8.5, "100", null, NaN]) {
      expect(parseDiskConfig({ ...GOOD, sizeGb })).toMatchObject({
        ok: false,
        fields: { sizeGb: "invalid" },
      });
    }
  });

  it("refuses a missing input", () => {
    for (const bad of [null, undefined, "x", [], 5]) {
      expect(parseDiskConfig(bad)).toMatchObject({ ok: false, error: "validation" });
    }
  });
});

describe("resolveDisk", () => {
  const config = () => {
    const parsed = parseDiskConfig(GOOD);
    if (!parsed.ok) throw new Error("fixture");
    return parsed.value;
  };

  it("prices the GB, not the disk: the per-GB price and the size as quantity (R4)", () => {
    const r = resolveDisk(config(), ANCHOR);
    expect(r).toMatchObject({
      ok: true,
      value: {
        family: "disk",
        productId: PRODUCT_ID,
        region: "ap-south-1",
        featureFlag: "disk",
        awsPriceUsd: "0.1000",
        quantity: "100",
        needs: [{ quotaCode: "disk_gb", amount: 100 }],
        resourceConfig: GOOD,
      },
    });
  });

  it("refuses a row that is not the active disk anchor of that Region", () => {
    for (const row of [
      { ...ANCHOR, family: "linux_instance" },
      { ...ANCHOR, active: false },
      { ...ANCHOR, region: "ap-southeast-1" },
      { ...ANCHOR, id: "0190bbbb-0000-7000-8000-0000000000ff" },
      { ...ANCHOR, billingUnit: "month" },
      { ...ANCHOR, awsPriceUsd: "0" },
    ]) {
      expect(resolveDisk(config(), row)).toMatchObject({
        ok: false,
        error: "validation",
        fields: { productId: "unavailable" },
      });
    }
  });
});

describe("checkDiskServer", () => {
  const server = {
    id: SERVER_ID,
    family: "linux_instance",
    state: "active",
    region: "ap-south-1",
  };

  it("accepts the customer's own active or stopped Linux server in the Region", () => {
    expect(checkDiskServer({ requested: SERVER_ID, region: "ap-south-1", server })).toEqual({
      ok: true,
      value: SERVER_ID,
    });
    expect(
      checkDiskServer({
        requested: SERVER_ID,
        region: "ap-south-1",
        server: { ...server, state: "stopped" },
      }).ok,
    ).toBe(true);
  });

  it("answers a missing server and another customer's alike (R8)", () => {
    const r = checkDiskServer({ requested: SERVER_ID, region: "ap-south-1", server: null });
    expect(r).toEqual({ ok: false, error: "validation", fields: { serverId: "invalid" } });
  });

  it("refuses a server that is not Linux, not live or in another Region", () => {
    for (const bad of [
      { ...server, family: "windows_instance" },
      { ...server, family: "disk" },
      { ...server, state: "creating" },
      { ...server, state: "suspended" },
      { ...server, state: "destroyed" },
      { ...server, id: "0190bbbb-0000-7000-8000-0000000000aa" },
    ]) {
      expect(checkDiskServer({ requested: SERVER_ID, region: "ap-south-1", server: bad })).toEqual({
        ok: false,
        error: "validation",
        fields: { serverId: "invalid" },
      });
    }
    expect(
      checkDiskServer({
        requested: SERVER_ID,
        region: "ap-south-1",
        server: { ...server, region: "ap-southeast-1" },
      }),
    ).toEqual({ ok: false, error: "validation", fields: { region: "invalid" } });
  });
});
