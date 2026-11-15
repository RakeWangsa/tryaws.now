import { describe, expect, it } from "vitest";
import {
  keyOptionOf,
  orderIsSlow,
  orderProgress,
  planSpecsOf,
  serverConfigOf,
  shortfallTopUpTaka,
} from "./servers-view.ts";

describe("planSpecsOf", () => {
  it("reads the specs the catalog sync writes", () => {
    expect(
      planSpecsOf({ vcpus: 2, ramGb: "0.5", diskGb: 20, transferGb: 1024, name: "Nano" }),
    ).toEqual({ vcpus: 2, ramGb: "0.5", diskGb: 20, transferGb: 1024 });
  });
  it("drops anything that is not a plain size (no markup, no floats as text)", () => {
    expect(planSpecsOf({ vcpus: "<b>", ramGb: "<i>", diskGb: -1, transferGb: 1.5 })).toEqual({});
    expect(planSpecsOf(null)).toEqual({});
  });
});

describe("serverConfigOf", () => {
  it("reads the display name, key and a valid IPv4 address", () => {
    expect(
      serverConfigOf({ displayName: "web", keyPairId: "k1", publicIpv4: "203.0.113.10" }),
    ).toEqual({
      displayName: "web",
      keyPairId: "k1",
      publicIp: "203.0.113.10",
      blueprintId: null,
    });
  });
  it("WPU-G3: reads the image id the server was ordered with, and only a plain id", () => {
    expect(serverConfigOf({ displayName: "w", blueprintId: "wordpress" }).blueprintId).toBe(
      "wordpress",
    );
    for (const bad of ["Ubuntu 24", "../x", 5, null, ""]) {
      expect(serverConfigOf({ displayName: "w", blueprintId: bad }).blueprintId).toBeNull();
    }
  });
  it("ignores an address that is not an IPv4 address, and anything that looks like an AWS id", () => {
    const config = serverConfigOf({
      displayName: "x",
      publicIpv4: "javascript:1",
      accountId: "123456789012",
    });
    expect(config.publicIp).toBeNull();
    expect(JSON.stringify(config)).not.toContain("123456789012");
  });
});

describe("orderProgress", () => {
  it("maps the create operation to the steps of 16.11", () => {
    expect(orderProgress(null)).toBe("paid");
    expect(orderProgress("queued")).toBe("creating");
    expect(orderProgress("running")).toBe("creating");
    expect(orderProgress("waiting")).toBe("creating");
    expect(orderProgress("needs_attention")).toBe("delayed");
    expect(orderProgress("succeeded")).toBe("ready");
    expect(orderProgress("failed")).toBe("failed");
    expect(orderProgress("something_new")).toBe("delayed");
  });
});

describe("orderIsSlow (WPU-X23)", () => {
  const created = new Date("2026-11-15T13:00:00Z");
  const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
  it("says so for a create still running after 10 minutes, and only then", () => {
    expect(orderIsSlow("creating", created, at(9))).toBe(false);
    expect(orderIsSlow("creating", created, at(10))).toBe(false);
    expect(orderIsSlow("creating", created, at(11))).toBe(true);
    expect(orderIsSlow("paid", created, at(30))).toBe(true);
    for (const done of ["ready", "failed", "delayed"] as const) {
      expect(orderIsSlow(done, created, at(30))).toBe(false);
    }
    expect(orderIsSlow("creating", new Date(Number.NaN), at(30))).toBe(false);
  });
});

describe("shortfallTopUpTaka", () => {
  it("rounds the shortfall up to whole taka, in integers", () => {
    expect(shortfallTopUpTaka(115000n, 100000n)).toBe(150n);
    expect(shortfallTopUpTaka(115001n, 100000n)).toBe(151n);
  });
  it("is null when the balance covers the total", () => {
    expect(shortfallTopUpTaka(100000n, 100000n)).toBeNull();
    expect(shortfallTopUpTaka(100000n, 100001n)).toBeNull();
  });
});

// WPU-Y5 (e): a stored key is offered to the wizard only when Lightsail ImportKeyPair can take it.
describe("keyOptionOf", () => {
  it("marks ssh-rsa keys of 2048 bits or more usable and every other stored key not usable", () => {
    const field = (b: Buffer) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(b.length);
      return Buffer.concat([head, b]);
    };
    const n = Buffer.alloc(256, 0xab);
    const rsa = `ssh-rsa ${Buffer.concat([field(Buffer.from("ssh-rsa")), field(Buffer.from([1, 0, 1])), field(Buffer.concat([Buffer.from([0]), n]))]).toString("base64")}`;
    const base = { id: "k1", name: "Laptop", fingerprint: "SHA256:a" };
    expect(keyOptionOf({ ...base, publicKey: rsa })).toEqual({ ...base, usable: true });
    expect(keyOptionOf({ ...base, publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA" })).toEqual({
      ...base,
      usable: false,
    });
  });
});
