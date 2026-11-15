import { describe, expect, it } from "vitest";
import { mapContainerPower, mapDbBlueprint, mapDistributionBundle } from "./catalog-extra";
import { containerPlanFrom } from "./container";

const bundle = (over: Record<string, unknown> = {}) => ({
  bundleId: "small_1_0",
  name: "Small",
  priceUsd: "5",
  transferPerMonthInGb: 50,
  isActive: true,
  ...over,
});

describe("mapDistributionBundle", () => {
  it("maps a good bundle to an active cdn row in us-east-1 with decimal text", () => {
    expect(mapDistributionBundle(bundle())).toEqual({
      family: "cdn",
      awsId: "small_1_0",
      platform: "global",
      region: "us-east-1",
      specs: { name: "Small", transferGb: 50 },
      awsPriceUsd: "5",
      billingUnit: "month",
      featureFlag: "cdn",
      active: true,
    });
  });
  it("stores an inactive or free bundle inactive", () => {
    expect(mapDistributionBundle(bundle({ isActive: false }))?.active).toBe(false);
    expect(mapDistributionBundle(bundle({ priceUsd: "0" }))?.active).toBe(false);
  });
  it("refuses a bad id, an empty or float-artifact price and a bad transfer (R4, R16)", () => {
    expect(mapDistributionBundle(bundle({ bundleId: "../x" }))).toBeNull();
    expect(mapDistributionBundle(bundle({ bundleId: "" }))).toBeNull();
    expect(mapDistributionBundle(bundle({ priceUsd: "" }))).toBeNull();
    expect(mapDistributionBundle(bundle({ priceUsd: "0.30000000000000004" }))).toBeNull();
    expect(mapDistributionBundle(bundle({ transferPerMonthInGb: Number.NaN }))).toBeNull();
    expect(mapDistributionBundle(bundle({ transferPerMonthInGb: -1 }))).toBeNull();
    expect(mapDistributionBundle(null)).toBeNull();
  });
  it("shows a name without control characters", () => {
    expect(mapDistributionBundle(bundle({ name: "Sm\u0000all" }))?.specs.name).toBe("Small");
  });
});

const blueprint = (over: Record<string, unknown> = {}) => ({
  blueprintId: "postgres_16",
  engine: "postgres",
  engineVersion: "16.4",
  engineDescription: "PostgreSQL",
  engineVersionDescription: "PostgreSQL 16.4-R1",
  isEngineDefault: true,
  ...over,
});

describe("mapDbBlueprint", () => {
  it("maps a blueprint to an unpriced db_blueprint row with specs.engine and specs.version", () => {
    expect(mapDbBlueprint(blueprint(), "ap-southeast-1")).toEqual({
      family: "db_blueprint",
      awsId: "postgres_16",
      platform: "managed",
      region: "ap-southeast-1",
      specs: { name: "PostgreSQL 16.4-R1", engine: "postgres", version: "16.4", isDefault: true },
      awsPriceUsd: "0",
      billingUnit: "none",
      featureFlag: "database",
      active: true,
    });
  });
  it("refuses a missing or odd id, engine, version or Region", () => {
    expect(mapDbBlueprint(blueprint({ blueprintId: "" }), "ap-southeast-1")).toBeNull();
    expect(mapDbBlueprint(blueprint({ engine: null }), "ap-southeast-1")).toBeNull();
    expect(mapDbBlueprint(blueprint({ engine: "po stgres" }), "ap-southeast-1")).toBeNull();
    expect(mapDbBlueprint(blueprint({ engineVersion: null }), "ap-southeast-1")).toBeNull();
    expect(mapDbBlueprint(blueprint({ engineVersion: "<b>" }), "ap-southeast-1")).toBeNull();
    expect(mapDbBlueprint(blueprint(), "nowhere")).toBeNull();
    expect(mapDbBlueprint(undefined, "ap-southeast-1")).toBeNull();
  });
  it("is not the default unless AWS says true", () => {
    expect(
      mapDbBlueprint(blueprint({ isEngineDefault: "true" }), "ap-southeast-1")?.specs.isDefault,
    ).toBe(false);
  });
});

describe("mapContainerPower (WPU-X20)", () => {
  const power = (over: Record<string, unknown> = {}) => ({
    powerId: "nano-1",
    name: "nano",
    priceUsd: "7",
    cpuCount: 0.25,
    ramSizeInGb: 0.5,
    isActive: true,
    ...over,
  });
  it("maps a power to an active row of scale 1 that containerPlanFrom reads back", () => {
    const row = mapContainerPower(power(), "ap-southeast-1");
    expect(row).toEqual({
      family: "container_service",
      awsId: "nano",
      platform: "container",
      region: "ap-southeast-1",
      specs: { name: "nano", scale: 1, vcpus: 0.25, ramGb: 0.5 },
      awsPriceUsd: "7",
      billingUnit: "month",
      featureFlag: "container_service",
      active: true,
    });
    expect(containerPlanFrom(row?.awsId, row?.specs)).toEqual({ power: "nano", scale: 1 });
  });
  it("stores an inactive or free power inactive", () => {
    expect(mapContainerPower(power({ isActive: false }), "us-east-1")?.active).toBe(false);
    expect(mapContainerPower(power({ priceUsd: "0" }), "us-east-1")?.active).toBe(false);
  });
  it("refuses an unknown power, a bad price, a bad size and a bad Region (R16)", () => {
    expect(mapContainerPower(power({ name: "huge", powerId: "huge-1" }), "us-east-1")).toBeNull();
    expect(mapContainerPower(power({ name: "", powerId: "small-1" }), "us-east-1")?.awsId).toBe(
      "small",
    );
    expect(mapContainerPower(power({ priceUsd: "7.00001" }), "us-east-1")).toBeNull();
    expect(mapContainerPower(power({ priceUsd: "" }), "us-east-1")).toBeNull();
    expect(mapContainerPower(power({ cpuCount: Number.NaN }), "us-east-1")).toBeNull();
    expect(mapContainerPower(power({ ramSizeInGb: 0 }), "us-east-1")).toBeNull();
    expect(mapContainerPower(power(), "nowhere")).toBeNull();
    expect(mapContainerPower(null, "us-east-1")).toBeNull();
  });
});
