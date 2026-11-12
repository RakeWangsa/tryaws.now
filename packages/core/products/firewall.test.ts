import { describe, expect, it } from "vitest";
import {
  FIREWALL_MAX_RULES,
  FIREWALL_PRESETS,
  addFirewallRule,
  currentFirewallRules,
  firewallRuleKey,
  parseFirewallRules,
  parseFirewallSources,
  parseNewFirewallRule,
  removeFirewallRule,
  rulesOpenSshToWorld,
  type FirewallRule,
} from "./firewall";

const ssh: FirewallRule = { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] };

describe("parseFirewallSources", () => {
  it("accepts IPv4 addresses and CIDR blocks, adds /32, drops duplicates", () => {
    expect(parseFirewallSources("203.0.113.7, 10.0.0.0/8\n203.0.113.7")).toEqual({
      ok: true,
      cidrs: ["203.0.113.7/32", "10.0.0.0/8"],
    });
    expect(parseFirewallSources("0.0.0.0/0")).toEqual({ ok: true, cidrs: ["0.0.0.0/0"] });
  });
  it.each(["", "  ", "999.1.1.1", "1.2.3.4/33", "1.2.3/24", "01.2.3.4", "$(id)", "1.2.3.4/-1"])(
    "refuses %j",
    (text) => {
      expect(parseFirewallSources(text).ok).toBe(false);
    },
  );
  it("separates an IPv6 block from a bad one", () => {
    expect(parseFirewallSources("2001:db8::/32")).toEqual({ ok: false, error: "ipv6" });
    expect(parseFirewallSources("::/0")).toEqual({ ok: false, error: "ipv6" });
    expect(parseFirewallSources("nonsense")).toEqual({ ok: false, error: "invalid" });
  });
  it("refuses more than 20 sources", () => {
    const many = Array.from({ length: 21 }, (_, i) => `10.0.0.${i}`).join(",");
    expect(parseFirewallSources(many)).toEqual({ ok: false, error: "too_many" });
  });
});

describe("parseNewFirewallRule", () => {
  it("builds a preset rule with its own protocol and ports", () => {
    expect(parseNewFirewallRule({ preset: "https", sources: "any" })).toEqual({
      ok: true,
      rule: { protocol: "tcp", fromPort: 443, toPort: 443, cidrs: ["0.0.0.0/0"] },
    });
    expect(FIREWALL_PRESETS.ping).toEqual({ protocol: "icmp", fromPort: 8, toPort: -1 });
  });
  it("custom: protocol, a port or a range, strict numbers", () => {
    expect(
      parseNewFirewallRule({
        preset: "custom",
        protocol: "udp",
        fromPort: "5000",
        toPort: "5100",
        sources: "10.1.0.0/16",
      }),
    ).toEqual({
      ok: true,
      rule: { protocol: "udp", fromPort: 5000, toPort: 5100, cidrs: ["10.1.0.0/16"] },
    });
    expect(
      parseNewFirewallRule({ preset: "custom", protocol: "tcp", fromPort: "8080", sources: "any" }),
    ).toMatchObject({ ok: true, rule: { fromPort: 8080, toPort: 8080 } });
  });
  it.each([
    { fromPort: "0x50", toPort: "80" },
    { fromPort: "1e2", toPort: "80" },
    { fromPort: "-1", toPort: "80" },
    { fromPort: "65536", toPort: "65536" },
    { fromPort: "90", toPort: "80" },
    { fromPort: "", toPort: "" },
    { fromPort: "80 ", toPort: "80x" },
  ])("custom refuses ports %j", (ports) => {
    const r = parseNewFirewallRule({ preset: "custom", protocol: "tcp", sources: "any", ...ports });
    expect(r.ok).toBe(false);
  });
  it("refuses an unknown preset, an unknown protocol, icmp as custom and a bad source", () => {
    expect(parseNewFirewallRule({ preset: "gopher", sources: "any" })).toMatchObject({ ok: false });
    expect(
      parseNewFirewallRule({ preset: "custom", protocol: "gre", fromPort: "1", sources: "any" }),
    ).toMatchObject({ ok: false, fields: { protocol: "invalid" } });
    expect(
      parseNewFirewallRule({ preset: "custom", protocol: "icmp", fromPort: "8", sources: "any" }),
    ).toMatchObject({ ok: false, fields: { protocol: "invalid" } });
    expect(parseNewFirewallRule({ preset: "http", sources: "1.2.3.999" })).toMatchObject({
      ok: false,
      fields: { sources: "invalid" },
    });
    expect(parseNewFirewallRule({ preset: "http", sources: "2001:db8::/32" })).toMatchObject({
      ok: false,
      fields: { sources: "ipv6" },
    });
  });
  it("'any' is every IPv4 address; an empty source is refused", () => {
    expect(parseNewFirewallRule({ preset: "ssh", sources: "" })).toMatchObject({ ok: false });
    expect(parseNewFirewallRule({ preset: "ssh", sources: "any" })).toMatchObject({
      ok: true,
      rule: { cidrs: ["0.0.0.0/0"] },
    });
  });
});

describe("rules list", () => {
  it("adds, refuses the same protocol and range twice, and caps the count", () => {
    const http: FirewallRule = { protocol: "tcp", fromPort: 80, toPort: 80, cidrs: ["0.0.0.0/0"] };
    expect(addFirewallRule([ssh], http)).toEqual({ ok: true, rules: [ssh, http] });
    expect(addFirewallRule([ssh], ssh)).toEqual({ ok: false, error: "duplicate" });
    const full = Array.from({ length: FIREWALL_MAX_RULES }, (_, i) => ({
      ...http,
      fromPort: 1000 + i,
      toPort: 1000 + i,
    }));
    expect(addFirewallRule(full, http)).toEqual({ ok: false, error: "too_many" });
  });
  it("removes by key and says when the key is not there", () => {
    expect(removeFirewallRule([ssh], firewallRuleKey(ssh))).toEqual({ ok: true, rules: [] });
    expect(removeFirewallRule([ssh], "tcp:80-80")).toEqual({ ok: false, error: "not_found" });
  });
  it("warns when SSH 22 is open to the world, also inside a range", () => {
    expect(rulesOpenSshToWorld([ssh])).toBe(true);
    expect(rulesOpenSshToWorld([{ ...ssh, fromPort: 1, toPort: 1024 }])).toBe(true);
    expect(rulesOpenSshToWorld([{ ...ssh, cidrs: ["203.0.113.7/32"] }])).toBe(false);
    expect(rulesOpenSshToWorld([{ ...ssh, protocol: "udp" }])).toBe(false);
    expect(rulesOpenSshToWorld([{ ...ssh, fromPort: 80, toPort: 80 }])).toBe(false);
  });
});

describe("parseFirewallRules (stored list)", () => {
  it("accepts a valid list and copies only the known fields", () => {
    expect(parseFirewallRules([{ ...ssh, extra: "x" }])).toEqual([ssh]);
    expect(parseFirewallRules([])).toEqual([]);
  });
  it.each([
    "all",
    null,
    [{ ...ssh, protocol: "gre" }],
    [{ ...ssh, fromPort: 70000, toPort: 70000 }],
    [{ ...ssh, cidrs: [] }],
    [{ ...ssh, cidrs: ["999.0.0.0/8"] }],
    [{ ...ssh, cidrs: ["$(id)"] }],
    [{ ...ssh, cidrs: ["10.0.0.1"] }],
    [{ ...ssh, fromPort: 22.5 }],
    [{ protocol: "icmp", fromPort: 8, toPort: 300, cidrs: ["0.0.0.0/0"] }],
  ])("refuses %j", (value) => {
    expect(parseFirewallRules(value)).toBeNull();
  });
  it("accepts ping (icmp 8 / -1)", () => {
    const ping = { protocol: "icmp", fromPort: 8, toPort: -1, cidrs: ["0.0.0.0/0"] };
    expect(parseFirewallRules([ping])).toEqual([ping]);
  });
});

describe("currentFirewallRules", () => {
  it("is the default of the family until a list is saved", () => {
    expect(currentFirewallRules({}, "linux_instance")).toEqual([ssh]);
    expect(currentFirewallRules(null, "windows_instance")).toEqual([
      { protocol: "tcp", fromPort: 3389, toPort: 3389, cidrs: ["0.0.0.0/0"] },
    ]);
  });
  it("is the saved list, also when it is empty, and null when the saved list is broken", () => {
    expect(currentFirewallRules({ firewallRules: [] }, "linux_instance")).toEqual([]);
    expect(
      currentFirewallRules({ firewallRules: [{ ...ssh, cidrs: ["x"] }] }, "linux_instance"),
    ).toBeNull();
  });
});
