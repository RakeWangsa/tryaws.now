import { describe, expect, it, vi } from "vitest";

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readLaunchInputs: async () => null,
}));

import { linuxDeps } from "./linux";

describe("linuxDeps (WPU-G1)", () => {
  it("reads the bootstrap marker through the beacon, not a constant answer", async () => {
    const deps = linuxDeps({ probeSources: "203.0.113.5/32" });
    // No public address yet: pending, and nothing is connected (the beacon needs a public IPv4).
    expect(
      await deps.bootstrapMarker({ instanceName: "tc-instance-x", region: "ap-southeast-1" }),
    ).toBe("pending");
    expect(
      await deps.bootstrapMarker({
        instanceName: "tc-instance-x",
        region: "ap-southeast-1",
        publicIp: "10.1.2.3",
      }),
    ).toBe("pending");
  });

  it("hands the checked probe sources to the adapter", async () => {
    const deps = linuxDeps({ probeSources: "203.0.113.5/32, 198.51.100.7/32" });
    expect(await deps.beaconSources?.({ region: "ap-southeast-1" })).toEqual([
      "203.0.113.5/32",
      "198.51.100.7/32",
    ]);
  });

  it("answers null (the create fails closed) for a missing, wide or private source list", async () => {
    for (const raw of [undefined, null, "", "0.0.0.0/0", "10.0.0.0/8", "garbage"]) {
      const deps = linuxDeps({ probeSources: raw });
      expect(await deps.beaconSources?.({ region: "ap-southeast-1" }), String(raw)).toBeNull();
    }
  });
});
