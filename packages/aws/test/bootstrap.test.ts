import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_EXPECTED_VPC_CIDR,
  BOOTSTRAP_MARKER_FILE,
  BOOTSTRAP_OK_MARKER,
  bootstrapScript,
} from "../adapters/bootstrap";

// 10.4 item 1: what the fixed template opens and what it closes. A text test: the real proof is
// tests/isolation in tc-pool-dev.
function accepts(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(" accept") && !l.startsWith("type "));
}

describe("bootstrapScript (10.4)", () => {
  const script = bootstrapScript();

  it("is fixed text: the same on every call, no placeholder, no customer input", () => {
    expect(bootstrapScript()).toBe(script);
    expect(script).not.toMatch(/\{\{|undefined|\[object/);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(Buffer.byteLength(script, "utf8")).toBeLessThan(16 * 1024);
  });

  it("reads the VPC CIDR with an IMDSv2 token and falls back to the expected value", () => {
    expect(script).toContain("X-aws-ec2-metadata-token-ttl-seconds");
    expect(script).toContain("X-aws-ec2-metadata-token:");
    expect(script).toContain("vpc-ipv4-cidr-block");
    expect(script).toContain(`FALLBACK_CIDR="${BOOTSTRAP_EXPECTED_VPC_CIDR}"`);
    expect(script).toContain("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$");
  });

  it("by default opens only established/related and DHCP, and port 80 is not open", () => {
    expect(accepts(script)).toEqual([
      "ct state established,related accept",
      "udp sport 67 udp dport 68 accept",
    ]);
    expect(script).not.toMatch(/dport (22|80|443|3306)\b/);
  });

  it("opens port 80 from the VPC CIDR only when the load balancer option is explicit", () => {
    const withLb = bootstrapScript({ allowLoadBalancerHttp: true });
    expect(accepts(withLb)).toEqual([
      "ct state established,related accept",
      "udp sport 67 udp dport 68 accept",
      "ip saddr $CIDR tcp dport 80 accept",
    ]);
    expect(withLb.indexOf("ip saddr $CIDR drop")).toBeGreaterThan(
      withLb.indexOf("dport 80 accept"),
    );
    expect(bootstrapScript({ allowLoadBalancerHttp: false })).toBe(script);
  });

  it("drops everything else from the VPC CIDR, before NAT (an nftables inet table, not ufw)", () => {
    expect(script).toContain("table inet tc_isolation");
    expect(script).toMatch(/hook prerouting priority -150;/);
    expect(script).toContain("ip saddr $CIDR drop");
    expect(script).not.toMatch(/\bufw\b/);
  });

  it("fails closed: strict shell, no `|| true` on the install, nft checked, rules read back", () => {
    expect(script.match(/set -euo pipefail/g)?.length).toBe(2);
    const install = script.split("\n").filter((l) => /apt-get|dnf/.test(l));
    expect(install.length).toBeGreaterThan(0);
    for (const line of install) expect(line).not.toContain("|| true");
    expect(script).toContain("command -v nft >/dev/null 2>&1 || exit 1");
    expect(script).toContain("nft list table inet tc_isolation >/dev/null");
    // the load is verified before the marker is written
    expect(script.indexOf("nft list table inet tc_isolation")).toBeLessThan(
      script.indexOf(`echo ${BOOTSTRAP_OK_MARKER} >`),
    );
  });

  it("ends with a marker that only a complete run prints, and clears the old one first", () => {
    expect(script.trimEnd().endsWith(`echo ${BOOTSTRAP_OK_MARKER}`)).toBe(true);
    expect(script).toContain(`test -s ${BOOTSTRAP_MARKER_FILE}`);
    expect(script).toContain(`rm -f ${BOOTSTRAP_MARKER_FILE}`);
  });

  it("loads the rules before any interface is up, and flushes the VPC conntrack entries", () => {
    expect(script).toContain("DefaultDependencies=no");
    expect(script).toContain("Before=network-pre.target");
    expect(script).toContain("Wants=network-pre.target");
    expect(script).toContain('conntrack -D -s "$CIDR"');
    // a missing conntrack tool is tolerated only after the rules were read back
    expect(script.indexOf("nft list table")).toBeLessThan(script.indexOf("conntrack -D"));
    expect(script).toContain("Type=oneshot");
    expect(script).toContain("RemainAfterExit=yes");
    expect(script).toContain("systemctl start tc-isolation.service");
  });
});
