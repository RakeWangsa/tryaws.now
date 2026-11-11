import { describe, expect, it } from "vitest";
import { BOOTSTRAP_OK_MARKER } from "../adapters/bootstrap";
import { windowsBootstrapScript } from "../adapters/bootstrap-windows";

describe("windowsBootstrapScript", () => {
  it("is a PowerShell user data that stops on error", () => {
    const s = windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" });
    expect(s.startsWith("<powershell>")).toBe(true);
    expect(s.trimEnd().endsWith("</powershell>")).toBe(true);
    expect(s).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("blocks the verified VPC CIDR with Windows Firewall rules, not the whole private range", () => {
    const s = windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" });
    expect(s).toContain("172.26.0.0/16");
    expect(s).toContain("New-NetFirewallRule");
    expect(s).toContain("-Action Block");
    expect(s).not.toContain("10.0.0.0/8");
  });

  it("blocks every RFC 1918 source when no valid CIDR was given (fail closed)", () => {
    for (const vpcCidr of [
      null,
      undefined,
      "",
      "not a cidr",
      "999.1.1.1/8",
      "172.26.0.0/16; calc",
    ]) {
      const s = windowsBootstrapScript({ vpcCidr });
      expect(s).toContain("10.0.0.0/8");
      expect(s).toContain("172.16.0.0/12");
      expect(s).toContain("192.168.0.0/16");
      expect(s).not.toContain("calc");
    }
  });

  it("keeps DHCP and the platform's own traffic working: block rules never cover UDP 68 or port 80", () => {
    const s = windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" });
    // Windows Firewall: block wins over allow, so the block is written around the exempt ports.
    expect(s).toContain("-Protocol TCP -LocalPort '1-79,81-65535'");
    expect(s).toContain("-Protocol UDP -LocalPort '1-67,69-65535'");
  });

  it("prints the marker only after the rules were read back, and writes it to a file", () => {
    const s = windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" });
    const rules = s.indexOf("Get-NetFirewallRule");
    const marker = s.indexOf(BOOTSTRAP_OK_MARKER);
    expect(rules).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(rules);
    expect(s).toContain("C:\\ProgramData\\tc-isolation.ok");
  });

  it("contains no customer text: the only inputs are a checked CIDR", () => {
    expect(windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" })).toBe(
      windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" }),
    );
  });
});
