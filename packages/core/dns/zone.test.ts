import { describe, expect, it } from "vitest";
import {
  DNS_ZONE_FLAG,
  DNS_ZONE_PRODUCT,
  DNS_ZONE_REGION,
  DNS_ZONE_STATES,
  DNS_ZONE_TERM_DAYS,
  parseDnsZoneConfig,
  resolveDnsZone,
  zoneStatusWord,
} from "./zone";

// WPU-G6: the DNS zone as the order path sees it. Pure. The name the customer typed is checked with
// validateZoneName and is the only customer text that reaches Route 53; the zone is priced from the
// market's config price (R4: a decimal text, no float), and a missing price sells nothing (R16).

describe("parseDnsZoneConfig", () => {
  it("accepts a zone name and the declaration of control, lower-cased, without the trailing dot", () => {
    expect(parseDnsZoneConfig({ zoneName: "Example.COM.", declaredControl: true })).toEqual({
      ok: true,
      value: { zoneName: "example.com" },
    });
  });

  it("requires the declaration that the customer controls the name (spec 12)", () => {
    for (const declaredControl of [false, "true", "on", undefined, 1]) {
      expect(parseDnsZoneConfig({ zoneName: "example.com", declaredControl })).toEqual({
        ok: false,
        error: "validation",
        fields: { declaredControl: "required" },
      });
    }
  });

  it("refuses names that are not a plain DNS name", () => {
    for (const zoneName of [
      "",
      "com",
      "exa mple.com",
      "-a.com",
      "a..com",
      "http://example.com",
      "example.com/path",
      "例え.jp",
      "1.2.3.4",
      "a".repeat(64) + ".com",
      42,
      null,
      undefined,
    ]) {
      const r = parseDnsZoneConfig({ zoneName, declaredControl: true });
      expect(r).toMatchObject({ ok: false, error: "validation" });
    }
  });

  it("drops every other key, so nothing else of the customer reaches the config (R11)", () => {
    const r = parseDnsZoneConfig({
      zoneName: "example.com",
      declaredControl: true,
      awsName: "tc-x",
      hostedZoneId: "Z1",
      tags: { a: "b" },
    });
    expect(r).toEqual({ ok: true, value: { zoneName: "example.com" } });
  });

  it("reads a body that is no object as empty", () => {
    for (const raw of [null, undefined, "x", 3, [1]]) {
      expect(parseDnsZoneConfig(raw)).toMatchObject({ ok: false, error: "validation" });
    }
  });
});

describe("resolveDnsZone", () => {
  const config = { zoneName: "example.com" };

  it("builds the product of a 30-day zone in tc-dns: no catalog row, no pool, no capacity", () => {
    const r = resolveDnsZone(config, { usd: "0.50" });
    expect(r).toMatchObject({
      ok: true,
      value: {
        family: "dns_zone",
        productId: DNS_ZONE_PRODUCT,
        region: DNS_ZONE_REGION,
        featureFlag: DNS_ZONE_FLAG,
        awsPriceUsd: "0.50",
        quantity: "1",
        needs: [],
        facts: { bundleUsd: "0", windows: false, staticIps: 0 },
      },
    });
    if (!r.ok) throw new Error("unreachable");
    // The zone name is in the resource config under the key the adapter reads; the display name is
    // the same name; no AWS name, no tag.
    expect(r.value.resourceConfig).toEqual({
      region: DNS_ZONE_REGION,
      displayName: "example.com",
      zoneName: "example.com",
      declaredControl: true,
    });
    // It parses again: the purchase reads the config out of the signed draft.
    expect(parseDnsZoneConfig(r.value.resourceConfig)).toEqual({
      ok: true,
      value: { zoneName: "example.com" },
    });
  });

  it("sells nothing when the price is missing or is not a plain decimal (R16, R4)", () => {
    // WPU-M2: a price of zero is no price either (a free zone by accident).
    const zeros = [{ usd: "0" }, { usd: "0.00" }, { usd: "0.0000" }];
    for (const price of [
      undefined,
      { usd: "" },
      { usd: "-1" },
      { usd: "1e3" },
      { usd: "0.5.1" },
      ...zeros,
    ]) {
      expect(resolveDnsZone(config, price as never)).toEqual({
        ok: false,
        error: "validation",
        fields: { price: "unavailable" },
      });
    }
  });

  it("has the constants of the spec", () => {
    expect(DNS_ZONE_TERM_DAYS).toBe(30);
    expect(DNS_ZONE_REGION).toBe("us-east-1");
    expect(DNS_ZONE_FLAG).toBe("dns_zone");
  });
});

describe("zoneStatusWord", () => {
  it("lists the states", () => {
    expect([...DNS_ZONE_STATES]).toEqual([
      "pending",
      "pending_delegation",
      "delegated",
      "removing",
      "removed",
      "failed",
    ]);
  });

  it("says pending while the resource is created, whatever the row says", () => {
    expect(zoneStatusWord({ resourceState: "creating", rowStatus: null })).toBe("pending");
    expect(zoneStatusWord({ resourceState: "creating", rowStatus: "delegated" })).toBe("pending");
  });

  it("follows the row once the zone is active; an unknown word is awaiting delegation", () => {
    expect(zoneStatusWord({ resourceState: "active", rowStatus: "delegated" })).toBe("delegated");
    expect(zoneStatusWord({ resourceState: "active", rowStatus: "pending_delegation" })).toBe(
      "pending_delegation",
    );
    expect(zoneStatusWord({ resourceState: "active", rowStatus: null })).toBe("pending_delegation");
    expect(zoneStatusWord({ resourceState: "active", rowStatus: "nonsense" })).toBe(
      "pending_delegation",
    );
  });

  it("is failed or removed when the resource is", () => {
    expect(zoneStatusWord({ resourceState: "failed", rowStatus: "pending" })).toBe("failed");
    expect(zoneStatusWord({ resourceState: "destroyed", rowStatus: "delegated" })).toBe("removed");
  });

  it("says removing while a destroy is on its way", () => {
    expect(
      zoneStatusWord({ resourceState: "active", rowStatus: "delegated", destroying: true }),
    ).toBe("removing");
  });
});
