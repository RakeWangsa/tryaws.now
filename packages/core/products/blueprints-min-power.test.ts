import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_MIN_POWER,
  EMPTY_ALLOW_LIST,
  mapBlueprint,
  minPowerOf,
  optionOf,
  planFitsImage,
} from "./blueprints";

// WPU-G10. The minimum bundle power of an image. Lightsail enforces it (GetBlueprints `minPower`, the
// unit of GetBundles `power`; WPU-Z19, the AWS CLI get-bundles example: 298 is nano_3_0 with 0.5 GB, 500 micro_3_0
// with 1 GB, 1000 small_3_0 with 2 GB; minPower 0 is every plan). The platform stores what AWS says, lets an admin
// override it per image, and when nothing is known falls back to a safe default: an app needs at least the 1 GB
// plan (power 500, owner ruling 2026-11-14), an OS-only image runs on every plan.
const item = (over: Record<string, unknown> = {}) => ({
  blueprintId: "wordpress",
  name: "WordPress",
  type: "app",
  group: "wordpress",
  version: "6",
  platform: "LINUX_UNIX",
  isActive: true,
  ...over,
});

describe("mapBlueprint keeps minPower", () => {
  it("stores the whole number AWS reports", () => {
    expect(mapBlueprint(item({ minPower: 1000 }), "ap-southeast-1")?.specs.minPower).toBe(1000);
    expect(mapBlueprint(item({ minPower: 0 }), "ap-southeast-1")?.specs.minPower).toBe(0);
  });
  it("stores null (unknown) for anything that is not a non-negative whole number", () => {
    for (const bad of [undefined, null, -1, 1.5, "1000", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mapBlueprint(item({ minPower: bad }), "ap-southeast-1")?.specs.minPower).toBeNull();
    }
  });
});

describe("minPowerOf", () => {
  const app = { id: "wordpress", kind: "app", minPower: null } as const;
  const os = { id: "ubuntu_24_04", kind: "os", minPower: null } as const;

  it("the default for an app with no known minimum is the 1 GB plan (power 500)", () => {
    expect(DEFAULT_APP_MIN_POWER).toBe(500);
    expect(minPowerOf(app, EMPTY_ALLOW_LIST)).toBe(500);
    // The 512 MB plan (298) does not fit an app with no known minimum; the 1 GB plan (500) does.
    expect(planFitsImage(minPowerOf(app, EMPTY_ALLOW_LIST), 298)).toBe(false);
    expect(planFitsImage(minPowerOf(app, EMPTY_ALLOW_LIST), 500)).toBe(true);
  });
  it("an OS-only image with no known minimum runs on every plan", () => {
    expect(minPowerOf(os, EMPTY_ALLOW_LIST)).toBe(0);
  });
  it("the value AWS reported wins over the default, including 0 for an app", () => {
    expect(minPowerOf({ ...app, minPower: 2000 }, EMPTY_ALLOW_LIST)).toBe(2000);
    expect(minPowerOf({ ...app, minPower: 0 }, EMPTY_ALLOW_LIST)).toBe(0);
  });
  it("the admin override wins over AWS and over the default", () => {
    const list = { on: [], off: [], minPower: { wordpress: 500, ubuntu_24_04: 1000 } };
    expect(minPowerOf({ ...app, minPower: 2000 }, list)).toBe(500);
    expect(minPowerOf(os, list)).toBe(1000);
  });
  it("an override for another image does not apply", () => {
    expect(minPowerOf(app, { on: [], off: [], minPower: { nodejs: 0 } })).toBe(500);
  });
});

describe("planFitsImage (R16)", () => {
  it("a plan at or above the minimum fits", () => {
    expect(planFitsImage(1000, 1000)).toBe(true);
    expect(planFitsImage(1000, 2000)).toBe(true);
  });
  it("a plan below the minimum does not", () => {
    expect(planFitsImage(1000, 500)).toBe(false);
  });
  it("a minimum of 0 fits every plan, also one whose power is unknown", () => {
    expect(planFitsImage(0, 500)).toBe(true);
    expect(planFitsImage(0, null)).toBe(true);
  });
  it("a plan whose power is unknown does not fit an image that has a minimum", () => {
    expect(planFitsImage(500, null)).toBe(false);
  });
});

describe("optionOf carries the synced minimum", () => {
  it("reads minPower from the specs of the row and null when the row has none", () => {
    expect(
      optionOf({ awsId: "wordpress", specs: { kind: "app", name: "WP", minPower: 1000 } })
        ?.minPower,
    ).toBe(1000);
    expect(
      optionOf({ awsId: "wordpress", specs: { kind: "app", name: "WP" } })?.minPower,
    ).toBeNull();
    expect(
      optionOf({ awsId: "wordpress", specs: { kind: "app", name: "WP", minPower: -5 } })?.minPower,
    ).toBeNull();
  });
});
