import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_BEACON_PORT, BOOTSTRAP_OK_MARKER } from "../adapters/bootstrap";
import {
  beaconVerdict,
  createBeaconMarker,
  isPublicIpv4,
  parseProbeSources,
} from "../adapters/bootstrap-probe";

describe("beaconVerdict (WPU-G1)", () => {
  it("is present only for the exact marker, with or without a final newline", () => {
    expect(beaconVerdict(BOOTSTRAP_OK_MARKER)).toBe("present");
    expect(beaconVerdict(`${BOOTSTRAP_OK_MARKER}\n`)).toBe("present");
  });

  it("is pending for no answer, an empty answer or any other text (fail closed, R16)", () => {
    for (const reply of [null, "", "\n", "TC_BOOTSTRAP_OK2", "xTC_BOOTSTRAP_OK", "OK", "SSH-2.0-x"])
      expect(beaconVerdict(reply), String(reply)).toBe("pending");
  });
});

describe("isPublicIpv4", () => {
  it("accepts a public dotted address", () => {
    expect(isPublicIpv4("52.220.10.20")).toBe(true);
    expect(isPublicIpv4("203.0.113.9")).toBe(true);
  });

  it("refuses names, private, loopback, link-local, multicast and malformed values", () => {
    for (const v of [
      "",
      "example.com",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.4 ",
      "::1",
    ])
      expect(isPublicIpv4(v), v).toBe(false);
    expect(isPublicIpv4(undefined)).toBe(false);
    expect(isPublicIpv4(null)).toBe(false);
  });
});

describe("parseProbeSources", () => {
  it("accepts a comma list of CIDRs no wider than /16 and returns them trimmed", () => {
    expect(parseProbeSources("203.0.113.5/32, 198.51.100.0/24")).toEqual([
      "203.0.113.5/32",
      "198.51.100.0/24",
    ]);
  });

  it("is null (not configured) for nothing, for a malformed entry and for anything wider than /16", () => {
    for (const v of [
      undefined,
      "",
      " ",
      "0.0.0.0/0",
      "203.0.113.0/15",
      "203.0.113.5",
      "203.0.113.5/32,bad",
      "10.0.0.0/8",
      "172.26.0.0/16",
      "203.0.113.5/32,,",
    ])
      expect(parseProbeSources(v), String(v)).toBeNull();
  });

  it("refuses a private range: the probe comes from the public egress of the platform", () => {
    expect(parseProbeSources("192.168.0.0/24")).toBeNull();
    expect(parseProbeSources("127.0.0.1/32")).toBeNull();
  });

  it("refuses more than 10 entries (the Lightsail rule takes a short list)", () => {
    const many = Array.from({ length: 11 }, (_, i) => `203.0.113.${i + 1}/32`).join(",");
    expect(parseProbeSources(many)).toBeNull();
  });
});

describe("createBeaconMarker", () => {
  const input = {
    instanceName: "tc-instance-x",
    region: "ap-southeast-1",
    publicIp: "52.220.10.20",
  };

  it("reads the beacon port of the public address and reports present", async () => {
    const seen: unknown[] = [];
    const marker = createBeaconMarker({
      connect: async (host, port) => {
        seen.push([host, port]);
        return `${BOOTSTRAP_OK_MARKER}\n`;
      },
    });
    expect(await marker(input)).toBe("present");
    expect(seen).toEqual([["52.220.10.20", BOOTSTRAP_BEACON_PORT]]);
  });

  it("is pending while nothing answers or the answer is empty", async () => {
    expect(await createBeaconMarker({ connect: async () => null })(input)).toBe("pending");
    expect(await createBeaconMarker({ connect: async () => "" })(input)).toBe("pending");
  });

  it("is pending when the connection fails (the instance may still be booting)", async () => {
    const marker = createBeaconMarker({
      connect: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 1.2.3.4"), { code: "ECONNREFUSED" });
      },
    });
    expect(await marker(input)).toBe("pending");
  });

  it("is pending without a public address and never connects to a private or a named host", async () => {
    let calls = 0;
    const marker = createBeaconMarker({
      connect: async () => {
        calls += 1;
        return BOOTSTRAP_OK_MARKER;
      },
    });
    expect(await marker({ ...input, publicIp: null })).toBe("pending");
    expect(await marker({ ...input, publicIp: undefined })).toBe("pending");
    expect(await marker({ ...input, publicIp: "10.0.0.5" })).toBe("pending");
    expect(await marker({ ...input, publicIp: "evil.example.com" })).toBe("pending");
    expect(calls).toBe(0);
  });

  it("the default transport is the guarded one in tests: it cannot leave the process", async () => {
    // network-guard.ts of this package blocks net.connect, so the real probe reports pending, not an error.
    expect(await createBeaconMarker()(input)).toBe("pending");
  });
});

describe("connectBeacon absolute deadline (security review)", () => {
  it("gives up on a peer that drips bytes, which keep resetting the idle timeout", async () => {
    const { EventEmitter } = await import("node:events");
    const net = (await import("node:net")).default;
    const { connectBeacon } = await import("../adapters/bootstrap-probe");
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: () => undefined,
      destroy: vi.fn(),
    });
    const spy = vi.spyOn(net, "connect").mockReturnValue(socket as never);
    try {
      const pending = connectBeacon("52.220.10.20", 52022, 1000);
      for (let i = 0; i < 5; i += 1) {
        socket.emit("data", Buffer.from("x"));
        await vi.advanceTimersByTimeAsync(150);
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(await pending).toBeNull();
      expect(socket.destroy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
