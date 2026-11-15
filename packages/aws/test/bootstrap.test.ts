import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_BEACON_PORT,
  BOOTSTRAP_EXPECTED_VPC_CIDR,
  BOOTSTRAP_FAIL_CLOSED_CIDRS,
  BOOTSTRAP_MARKER_FILE,
  BOOTSTRAP_OK_MARKER,
  bootstrapScript,
  isValidCidr,
} from "../adapters/bootstrap";

// 10.4 item 1: what the fixed template opens and what it closes. A text test: the real proof is
// tests/isolation in tc-pool-dev.
const CIDR = BOOTSTRAP_EXPECTED_VPC_CIDR;
function accepts(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(" accept") && !l.startsWith("type "));
}
const at = (script: string, text: string): number => {
  const i = script.indexOf(text);
  expect(i, text).toBeGreaterThanOrEqual(0);
  return i;
};

describe("bootstrapScript (10.4)", () => {
  const script = bootstrapScript({ vpcCidr: CIDR });

  it("is fixed text: the same on every call, no placeholder, no customer input", () => {
    expect(bootstrapScript({ vpcCidr: CIDR })).toBe(script);
    expect(script).not.toMatch(/\{\{|undefined|\[object/);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(Buffer.byteLength(script, "utf8")).toBeLessThan(16 * 1024);
  });

  it("uses the persisted literal CIDR: no metadata call at boot, no silent fallback", () => {
    expect(script).toContain(`ip saddr { ${CIDR} } drop`);
    expect(script).not.toMatch(/169\.254\.169\.254|curl|FALLBACK|metadata/);
  });

  it("without a valid CIDR it drops every RFC 1918 source", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "garbage",
      "300.1.1.1/16",
      "10.0.0.0/33",
      "10.0.0.0/8; reboot",
    ]) {
      const s = bootstrapScript({ vpcCidr: bad as never });
      expect(s).toContain(`ip saddr { ${BOOTSTRAP_FAIL_CLOSED_CIDRS.join(", ")} } drop`);
      expect(s).not.toContain(CIDR);
    }
    expect(BOOTSTRAP_FAIL_CLOSED_CIDRS).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
    expect(isValidCidr(CIDR)).toBe(true);
    expect(isValidCidr("10.0.0.0/8\n")).toBe(false);
  });

  it("by default opens only established/related and DHCP, and port 80 is not open", () => {
    expect(accepts(script)).toEqual([
      "ct state established,related accept",
      "udp sport 67 udp dport 68 accept",
    ]);
    expect(script).not.toMatch(/dport (22|80|443|3306)\b/);
  });

  it("opens port 80 only when explicit, and only with a valid CIDR", () => {
    const withLb = bootstrapScript({ vpcCidr: CIDR, allowLoadBalancerHttp: true });
    expect(accepts(withLb)).toEqual([
      "ct state established,related accept",
      "udp sport 67 udp dport 68 accept",
      `ip saddr { ${CIDR} } tcp dport 80 accept`,
    ]);
    expect(at(withLb, "} drop")).toBeGreaterThan(at(withLb, "dport 80 accept"));
    expect(() => bootstrapScript({ allowLoadBalancerHttp: true })).toThrow(/VPC CIDR/);
    expect(bootstrapScript({ vpcCidr: CIDR, allowLoadBalancerHttp: false })).toBe(script);
  });

  it("drops the rest before NAT (an nftables inet table, not ufw)", () => {
    expect(script).toContain("table inet tc_isolation");
    expect(script).toMatch(/hook prerouting priority -150;/);
    expect(script).not.toMatch(/\bufw\b/);
  });

  it("fails closed: strict shell, no `|| true`, both tools installed and checked", () => {
    expect(script.match(/set -euo pipefail/g)?.length).toBe(2);
    expect(script).not.toContain("|| true");
    // installed unconditionally, not inside a check for nft
    expect(script).toContain("apt-get install -y nftables conntrack");
    expect(script).toContain("dnf install -y nftables conntrack-tools");
    expect(script).not.toMatch(/if ! command -v nft/);
    expect(script).toContain("command -v nft >/dev/null 2>&1 || exit 1");
    expect(script).toContain("command -v conntrack >/dev/null 2>&1 || exit 1");
  });

  it("[WPU-X28] a small instance gets a temporary swap file before the package install, removed after it", () => {
    const swapOn = at(script, 'swapon "$TC_SWAP"');
    expect(at(script, "fallocate -l 1G")).toBeLessThan(swapOn);
    expect(swapOn).toBeLessThan(at(script, "apt-get update"));
    expect(at(script, "dnf install")).toBeLessThan(at(script, 'swapoff "$TC_SWAP"'));
    expect(at(script, 'swapoff "$TC_SWAP"')).toBeLessThan(at(script, "command -v nft"));
    // only below 2 GB of memory, and nothing is made permanent
    expect(script).toContain("-lt 2000000");
    expect(script).not.toMatch(/fstab/);
  });

  it("the rules come first; reading them back precedes the flush; the flush is fatal except 'nothing matched'", () => {
    const rules = script.slice(at(script, "TC_RULES_EOF'"), script.lastIndexOf("TC_RULES_EOF"));
    expect(at(rules, "nft -f -")).toBeLessThan(at(rules, "nft list table inet tc_isolation"));
    expect(at(rules, "nft list table")).toBeLessThan(at(rules, "conntrack -D"));
    expect(rules).toContain('conntrack -D -s "$c" >/dev/null 2>&1 || [ $? -eq 1 ]');
    expect(rules).toContain("command -v conntrack >/dev/null 2>&1 || exit 1");
    // nothing about the marker, the directory or the file system can stop the rule load
    expect(rules).not.toMatch(/install -d|rm -f|echo|var\/lib/);
    expect(bootstrapScript({ vpcCidr: CIDR })).toContain(`for c in ${CIDR}; do`);
  });

  it("writes the marker in a separate last step, only after the unit started", () => {
    expect(script.trimEnd().endsWith(`echo ${BOOTSTRAP_OK_MARKER}`)).toBe(true);
    expect(at(script, "systemctl start tc-isolation.service")).toBeLessThan(
      at(script, `echo ${BOOTSTRAP_OK_MARKER} > ${BOOTSTRAP_MARKER_FILE}`),
    );
  });

  it("WPU-G1: a beacon unit serves the marker file, is started and checked before the marker is written, and the marker stays last", () => {
    expect(script).toContain("tc-beacon.service");
    expect(script).toContain(`PORT = ${BOOTSTRAP_BEACON_PORT}`);
    const beacon = script.slice(at(script, "TC_BEACON_EOF'"), script.lastIndexOf("TC_BEACON_EOF"));
    // the beacon sends the content of the marker file and nothing else, and never a customer value
    expect(beacon).toContain(BOOTSTRAP_MARKER_FILE);
    expect(beacon).not.toMatch(/environ|argv|os\.system|subprocess|eval|exec/);
    expect(at(script, "systemctl start tc-isolation.service")).toBeLessThan(
      at(script, "systemctl start tc-beacon.service"),
    );
    expect(at(script, "systemctl start tc-beacon.service")).toBeLessThan(
      at(script, `echo ${BOOTSTRAP_OK_MARKER} > ${BOOTSTRAP_MARKER_FILE}`),
    );
    // the start of the beacon is checked: a dead beacon means no marker
    expect(script).toContain("systemctl is-active --quiet tc-beacon.service");
    expect(script.trimEnd().endsWith(`echo ${BOOTSTRAP_OK_MARKER}`)).toBe(true);
    expect(script.match(/set -euo pipefail/g)?.length).toBe(2);
    expect(script).not.toContain("|| true");
  });

  it("the beacon port is a fixed non-privileged TCP port", () => {
    expect(BOOTSTRAP_BEACON_PORT).toBeGreaterThan(1024);
    expect(BOOTSTRAP_BEACON_PORT).toBeLessThan(65536);
  });

  it("orders the unit before the network, after the mounts it needs", () => {
    expect(script).toContain("DefaultDependencies=no");
    expect(script).toContain("After=local-fs.target");
    expect(script).toContain("RequiresMountsFor=/var/lib /usr/local/sbin");
    expect(script).toContain("Before=network-pre.target");
    expect(script).toContain("Wants=network-pre.target");
    expect(script).toContain("Type=oneshot");
    expect(script).toContain("RemainAfterExit=yes");
    expect(script).toContain("systemctl enable tc-isolation.service");
  });
});
