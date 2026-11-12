import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  image: vi.fn(),
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readLaunchInputs: mocks.launch,
  readImage: mocks.image,
}));

import { linuxDeps } from "./linux";

const CID = "0190a000-0000-7000-8000-00000000000c";
const PID = "0190a000-0000-7000-8000-00000000000d";
const KID = "0190a000-0000-7000-8000-00000000000e";
const input = (blueprintId: string | null) => ({
  customerId: CID,
  productId: PID,
  keyPairId: KID,
  blueprintId,
  region: "ap-southeast-1",
});

describe("linuxDeps.loadLaunch (WPU-G3)", () => {
  it("launches the image that was ordered, after checking it is still active in the Region", async () => {
    mocks.launch.mockResolvedValue({ bundleId: "nano_3_0", publicKey: "ssh-ed25519 AAAA" });
    mocks.image.mockResolvedValue({
      awsId: "wordpress",
      region: "ap-southeast-1",
      specs: {},
      active: true,
    });
    const spec = await linuxDeps().loadLaunch(input("wordpress"));
    expect(spec).toEqual({
      bundleId: "nano_3_0",
      blueprintId: "wordpress",
      publicKey: "ssh-ed25519 AAAA",
    });
    expect(mocks.image).toHaveBeenCalledWith({}, "ap-southeast-1", "wordpress");
  });

  it("an order without an image gets the default image and reads no image row", async () => {
    mocks.image.mockClear();
    mocks.launch.mockResolvedValue({ bundleId: "nano_3_0", publicKey: "k" });
    const spec = await linuxDeps().loadLaunch(input(null));
    expect(spec?.blueprintId).toBe("ubuntu_24_04");
    expect(mocks.image).not.toHaveBeenCalled();
  });

  it("fails closed (null) for an image AWS no longer lists, an inactive one, and a missing key or plan", async () => {
    mocks.launch.mockResolvedValue({ bundleId: "nano_3_0", publicKey: "k" });
    mocks.image.mockResolvedValue(null);
    expect(await linuxDeps().loadLaunch(input("gone_image"))).toBeNull();
    mocks.image.mockResolvedValue({ awsId: "x", region: "r", specs: {}, active: false });
    expect(await linuxDeps().loadLaunch(input("x"))).toBeNull();
    mocks.launch.mockResolvedValue(null);
    expect(await linuxDeps().loadLaunch(input(null))).toBeNull();
  });
});

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
