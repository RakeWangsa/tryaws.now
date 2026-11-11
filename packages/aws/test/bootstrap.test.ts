import { describe, expect, it } from "vitest";
import { BOOTSTRAP_EXPECTED_VPC_CIDR, bootstrapScript } from "../adapters/bootstrap";

// 10.4 item 1: what the fixed template opens and what it closes. A text test: the real proof is
// tests/isolation in tc-pool-dev.
describe("bootstrapScript (10.4)", () => {
  const script = bootstrapScript();

  it("is one fixed text: the same on every call, no placeholder, no customer input", () => {
    expect(bootstrapScript()).toBe(script);
    expect(bootstrapScript.length).toBe(0);
    expect(script).not.toMatch(/\{\{|undefined|\[object/);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    // user data of Lightsail is limited to 16 KB
    expect(Buffer.byteLength(script, "utf8")).toBeLessThan(16 * 1024);
  });

  it("reads the VPC CIDR with an IMDSv2 token and falls back to the expected value (fails closed)", () => {
    expect(script).toContain("X-aws-ec2-metadata-token-ttl-seconds");
    expect(script).toContain("X-aws-ec2-metadata-token:");
    expect(script).toContain("network/interfaces/macs/");
    expect(script).toContain("vpc-ipv4-cidr-block");
    expect(BOOTSTRAP_EXPECTED_VPC_CIDR).toBe("172.26.0.0/16");
    expect(script).toContain(`FALLBACK_CIDR="${BOOTSTRAP_EXPECTED_VPC_CIDR}"`);
    // an unusable value is replaced, never used in a rule
    expect(script).toContain("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$");
  });

  it("opens exactly: established/related, DHCP (udp 67 to 68) and tcp 80 from the VPC CIDR", () => {
    const accepts = script
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(" accept") && !l.startsWith("type "));
    expect(accepts).toEqual([
      "ct state established,related accept",
      "udp sport 67 udp dport 68 accept",
      "ip saddr $CIDR tcp dport 80 accept",
    ]);
    expect(script).not.toMatch(/dport (22|443|3306)\b/);
  });

  it("drops everything else from the VPC CIDR, before NAT (an nftables inet table, not ufw)", () => {
    expect(script).toContain("table inet tc_isolation");
    expect(script).toMatch(/hook prerouting priority -150;/);
    expect(script).toContain("ip saddr $CIDR drop");
    // the drop is the last rule, so the three accepts come first
    expect(script.indexOf("ip saddr $CIDR drop")).toBeGreaterThan(
      script.indexOf("ip saddr $CIDR tcp dport 80 accept"),
    );
    expect(script).not.toMatch(/\bufw\b/);
  });

  it("applies the rules on every boot through a systemd unit", () => {
    expect(script).toContain("/etc/systemd/system/tc-isolation.service");
    expect(script).toContain("Type=oneshot");
    expect(script).toContain("RemainAfterExit=yes");
    expect(script).toContain("WantedBy=multi-user.target");
    expect(script).toContain("systemctl enable --now tc-isolation.service");
  });
});
