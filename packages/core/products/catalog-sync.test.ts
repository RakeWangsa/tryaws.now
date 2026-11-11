import { describe, expect, it } from "vitest";
import {
  decideActive,
  mapInstanceBundle,
  planIsSafe,
  planScopeSync,
  type RawBundle,
} from "./catalog-sync";

const bundle = (over: Partial<RawBundle> = {}): RawBundle => ({
  bundleId: "nano_3_0",
  name: "Nano",
  cpuCount: 2,
  ramSizeInGb: 0.5,
  diskSizeInGb: 20,
  transferPerMonthInGb: 1024,
  priceUsd: "5",
  publicIpv4AddressCount: 1,
  supportedPlatforms: ["LINUX_UNIX"],
  isActive: true,
  instanceType: "nano",
  power: null,
  ...over,
});
const rowsOf = (raw: RawBundle) => {
  const r = mapInstanceBundle(raw, "ap-southeast-1");
  if (!r.ok) throw new Error("refused " + r.reason);
  return r.rows;
};
const reason = (raw: RawBundle) => {
  const r = mapInstanceBundle(raw, "ap-southeast-1");
  return r.ok ? "mapped" : r.reason;
};

describe("mapInstanceBundle", () => {
  it("maps a Linux bundle to one active linux_instance row", () => {
    const rows = rowsOf(bundle());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      family: "linux_instance",
      platform: "linux",
      featureFlag: "linux_instance",
      awsId: "nano_3_0",
      region: "ap-southeast-1",
      awsPriceUsd: "5",
      billingUnit: "month",
      active: true,
    });
    expect(rows[0]!.specs).toMatchObject({ vcpus: 2, ramGb: "0.5", ipv6Only: false });
  });

  it("an IPv6-only plan is stored inactive and marked", () => {
    const rows = rowsOf(bundle({ publicIpv4AddressCount: 0, priceUsd: "3.5" }));
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.specs.ipv6Only).toBe(true);
    expect(rows[0]!.awsPriceUsd).toBe("3.5");
  });

  it("one row per known platform, same awsId", () => {
    const rows = rowsOf(bundle({ supportedPlatforms: ["LINUX_UNIX", "WINDOWS"] }));
    expect(rows.map((r) => r.family).sort()).toEqual(["linux_instance", "windows_instance"]);
    expect(new Set(rows.map((r) => r.awsId)).size).toBe(1);
  });

  it("maps WINDOWS and counts an unknown platform next to a known one", () => {
    const only = rowsOf(bundle({ supportedPlatforms: ["WINDOWS"] }));
    expect(only[0]).toMatchObject({ family: "windows_instance", platform: "windows" });
    const mixed = mapInstanceBundle(bundle({ supportedPlatforms: ["WINDOWS", "FREEBSD"] }), "x");
    expect(mixed.ok && mixed.skippedPlatforms).toBe(1);
  });

  it("refuses a bundle with no known platform", () => {
    expect(reason(bundle({ supportedPlatforms: ["FREEBSD"] }))).toBe("platform_unknown");
    expect(reason(bundle({ supportedPlatforms: [] }))).toBe("platform_unknown");
  });

  it("stores a bundle that AWS marks inactive, or priced 0, as inactive", () => {
    expect(rowsOf(bundle({ isActive: false }))[0]!.active).toBe(false);
    expect(rowsOf(bundle({ priceUsd: "0" }))[0]!.active).toBe(false);
    expect(rowsOf(bundle({ priceUsd: "0.0000" }))[0]!.active).toBe(false);
  });

  it.each(["1e-7", "-1", "", "5.12345", "0x10", " 5", "5.", ".5"])("refuses price %j", (p) => {
    expect(reason(bundle({ priceUsd: p }))).toBe("price_invalid");
  });

  it.each([0, 1.5, Number.NaN, -2])("refuses cpuCount %s", (c) => {
    expect(reason(bundle({ cpuCount: c }))).toBe("cpu_invalid");
  });

  it.each(["../x", "A B", "", "a".repeat(65), "-x", "nano\n"])("refuses bundleId %j", (id) => {
    expect(reason(bundle({ bundleId: id }))).toBe("bundle_id_invalid");
  });

  it("accepts a 64 character id", () => {
    expect(reason(bundle({ bundleId: "a".repeat(64) }))).toBe("mapped");
  });
});

describe("decideActive", () => {
  it("is false for an IPv4 count that is not an integer of at least 1", () => {
    for (const n of [1.5, -1, "1" as unknown as number, undefined as unknown as number, 0]) {
      expect(decideActive(bundle({ publicIpv4AddressCount: n }))).toBe(false);
    }
    expect(decideActive(bundle())).toBe(true);
  });

  it("property: active implies IPv4 >= 1, price > 0, isActive (200 bundles, fixed seed)", () => {
    let seed = 20261111;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const prices = ["0", "0.0000", "3.5", "5", "1e-7", "-1", "", "12.3456", "7.12345", "abc"];
    const counts = [0, 1, 2, 1.5, -1, Number.NaN];
    const cpus = [0, 1, 2, 4, 1.5, Number.NaN];
    let actives = 0;
    for (let i = 0; i < 200; i += 1) {
      const raw = bundle({
        bundleId: `b_${i}`,
        priceUsd: prices[Math.floor(next() * prices.length)]!,
        publicIpv4AddressCount: counts[Math.floor(next() * counts.length)]!,
        cpuCount: cpus[Math.floor(next() * cpus.length)]!,
        isActive: next() > 0.3,
      });
      const mapped = mapInstanceBundle(raw, "ap-southeast-1");
      if (!mapped.ok) continue;
      for (const row of mapped.rows) {
        if (!row.active) continue;
        actives += 1;
        expect(raw.publicIpv4AddressCount).toBeGreaterThanOrEqual(1);
        expect(/[1-9]/.test(row.awsPriceUsd)).toBe(true);
        expect(raw.isActive).toBe(true);
        expect(row.specs.ipv6Only).toBe(false);
      }
    }
    expect(actives).toBeGreaterThan(0);
  });
});

describe("planScopeSync", () => {
  const region = "ap-southeast-1";
  const families = ["linux_instance"];
  const three = [
    bundle({ bundleId: "nano_3_0" }),
    bundle({ bundleId: "micro_3_0", priceUsd: "7" }),
    bundle({ bundleId: "small_3_0", priceUsd: "12" }),
  ];

  it("upserts all mapped rows and deactivates only the active row that is gone", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: three,
      existing: [
        { family: "linux_instance", awsId: "nano_3_0", active: true },
        { family: "linux_instance", awsId: "old_1_0", active: true },
      ],
    });
    expect(plan.upserts).toHaveLength(3);
    expect(plan.deactivate).toEqual([{ family: "linux_instance", awsId: "old_1_0", region }]);
    expect(plan.counts).toMatchObject({
      seen: 3,
      mapped: 3,
      refused: 0,
      active: 3,
      deactivated: 1,
    });
  });

  it("is idempotent: a second plan from the first plan's rows deactivates nothing", () => {
    const first = planScopeSync({ region, families, bundles: three, existing: [] });
    const second = planScopeSync({
      region,
      families,
      bundles: three,
      existing: first.upserts.map((r) => ({ family: r.family, awsId: r.awsId, active: r.active })),
    });
    expect(second.upserts).toEqual(first.upserts);
    expect(second.deactivate).toEqual([]);
  });

  it("never deactivates a row of a family outside the scope, or one that is already inactive", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: three,
      existing: [
        { family: "windows_instance", awsId: "gone", active: true },
        { family: "linux_instance", awsId: "gone2", active: false },
      ],
    });
    expect(plan.deactivate).toEqual([]);
  });

  it("drops rows of a family that is not in the scope", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: [bundle({ supportedPlatforms: ["LINUX_UNIX", "WINDOWS"] })],
      existing: [],
    });
    expect(plan.upserts.map((r) => r.family)).toEqual(["linux_instance"]);
  });

  it("deactivates an existing active row whose new bundle is refused", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: [bundle({ bundleId: "nano_3_0", priceUsd: "1e-7" }), bundle({ bundleId: "ok_1" })],
      existing: [{ family: "linux_instance", awsId: "nano_3_0", active: true }],
    });
    expect(plan.deactivate).toEqual([{ family: "linux_instance", awsId: "nano_3_0", region }]);
    expect(plan.counts.refused).toBe(1);
    expect(plan.upserts.map((r) => r.awsId)).toEqual(["ok_1"]);
  });

  it("counts IPv6-only rows and keeps the first of a repeated id", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: [
        bundle({ bundleId: "v6", publicIpv4AddressCount: 0 }),
        bundle({ bundleId: "v6", priceUsd: "99" }),
      ],
      existing: [],
    });
    expect(plan.upserts).toHaveLength(1);
    expect(plan.counts.inactiveIpv6).toBe(1);
    expect(plan.counts.active).toBe(0);
  });
});

describe("planIsSafe", () => {
  const region = "ap-southeast-1";
  const families = ["linux_instance"];
  it("is false for an empty answer while active rows exist, true when none exist", () => {
    const empty = planScopeSync({ region, families, bundles: [], existing: [] });
    expect(planIsSafe(empty, 3)).toBe(false);
    expect(planIsSafe(empty, 0)).toBe(true);
  });
  it("is false when everything was refused and the plan would only deactivate", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: [bundle({ priceUsd: "" })],
      existing: [{ family: "linux_instance", awsId: "nano_3_0", active: true }],
    });
    expect(planIsSafe(plan, 1)).toBe(false);
  });
  it("is true for a normal plan", () => {
    const plan = planScopeSync({
      region,
      families,
      bundles: [bundle()],
      existing: [{ family: "linux_instance", awsId: "old", active: true }],
    });
    expect(planIsSafe(plan, 1)).toBe(true);
  });
});
