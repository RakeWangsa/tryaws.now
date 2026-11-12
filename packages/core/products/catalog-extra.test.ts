import { describe, expect, it } from "vitest";
import { mapDbBlueprint, mapDistributionBundle } from "./catalog-extra";

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
