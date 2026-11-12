import { describe, expect, it } from "vitest";
import { orderProgress, planSpecsOf, serverConfigOf, shortfallTopUpTaka } from "./servers-view.ts";

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
