import { describe, expect, it } from "vitest";
import { BOOTSTRAP_OK_MARKER } from "../adapters/bootstrap";
import {
  cidrWithout,
  WINDOWS_BOOTSTRAP_RULE_COUNT,
  windowsBootstrapScript,
} from "../adapters/bootstrap-windows";

const CIDR = "172.26.0.0/16";

describe("windowsBootstrapScript", () => {
  it("is a PowerShell user data that stops on error", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    expect(s.startsWith("<powershell>")).toBe(true);
    expect(s.trimEnd().endsWith("</powershell>")).toBe(true);
    expect(s).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("blocks the verified VPC CIDR, not the whole private range", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    expect(s).toContain(`$sources = @('${CIDR}')`);
    expect(s).not.toContain("10.0.0.0/8");
  });

  it("blocks every RFC 1918 source when no valid CIDR was given (fail closed)", () => {
    for (const vpcCidr of [null, undefined, "", "not a cidr", "999.1.1.1/8", `${CIDR}; calc`]) {
      const s = windowsBootstrapScript({ vpcCidr });
      expect(s).toContain("'10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'");
      expect(s).not.toContain("calc");
    }
  });

  it("blocks TCP 80 by default: all of 1-65535", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    expect(s).toContain("-Protocol TCP -LocalPort '1-65535'");
    expect(s).not.toContain("81-65535");
  });

  it("opens TCP 80 only on request, and only with a valid CIDR", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR, allowLoadBalancerHttp: true });
    expect(s).toContain("-Protocol TCP -LocalPort '1-79,81-65535'");
    for (const vpcCidr of [null, undefined, "", "bad", "300.0.0.0/8"]) {
      expect(() => windowsBootstrapScript({ vpcCidr, allowLoadBalancerHttp: true })).toThrow();
    }
  });

  it("exempts DHCP by remote port 67 only, not a whole UDP port", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    expect(s).toContain("-Protocol UDP -LocalPort '1-67,69-65535'");
    // no address given: strict, local 68 is blocked from every source
    expect(s).toContain("-Protocol UDP -LocalPort '68' -RemoteAddress $sources");
    expect(s).not.toContain("-RemotePort");
  });

  it("lets UDP 68 through only from the one DHCP /32; everything else of the CIDR stays blocked", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR, dhcpServer: "172.26.0.1" });
    expect(s).toContain(
      "-Protocol UDP -LocalPort '68' -RemoteAddress @('172.26.0.0-172.26.0.0','172.26.0.2-172.26.255.255')",
    );
    // the other UDP and TCP rules still cover the whole CIDR, the server's address included
    expect(s).toContain("-Protocol UDP -LocalPort '1-67,69-65535' -RemoteAddress $sources");
    expect(s).toContain("-LocalPort '1-65535' -RemoteAddress $sources");
    expect(s).not.toContain("-RemotePort");
    expect(cidrWithout(CIDR, "172.26.0.1")).toEqual([
      "172.26.0.0-172.26.0.0",
      "172.26.0.2-172.26.255.255",
    ]);
  });

  it("falls back to strict mode for a missing, malformed or foreign DHCP address, never loosening", () => {
    const strict = "-Protocol UDP -LocalPort '68' -RemoteAddress $sources";
    for (const dhcpServer of [
      null,
      undefined,
      "",
      "x",
      "172.27.0.1",
      "172.26.0.256",
      "172.26.0.1/32",
    ]) {
      expect(windowsBootstrapScript({ vpcCidr: CIDR, dhcpServer }), String(dhcpServer)).toContain(
        strict,
      );
    }
    // an address with no valid CIDR is not honoured either
    expect(windowsBootstrapScript({ vpcCidr: null, dhcpServer: "172.26.0.1" })).toContain(strict);
  });

  it("checks for a DHCP lease before the marker, in both modes", () => {
    for (const dhcpServer of [null, "172.26.0.1"]) {
      const s = windowsBootstrapScript({ vpcCidr: CIDR, dhcpServer });
      const lease = s.indexOf("PrefixOrigin -eq 'Dhcp'");
      expect(lease).toBeGreaterThan(-1);
      expect(s.indexOf("if ($lease.Count -lt 1) { exit 1 }")).toBeGreaterThan(lease);
      expect(s.indexOf(BOOTSTRAP_OK_MARKER)).toBeGreaterThan(lease);
    }
  });

  it("has no rule whose exemption is only a remote port (the sender controls it)", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    for (const line of s.split("\n").filter((l) => l.includes("-Protocol UDP"))) {
      expect(line, line).toContain("-LocalPort");
    }
    expect(s).toContain("tc-isolation-udp-dhcp");
    expect(WINDOWS_BOOTSTRAP_RULE_COUNT).toBe(257);
  });

  it("covers ICMP and every other protocol number, but not TCP or UDP twice", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    const list = /foreach \(\$p in @\(([\d,]+)\)\)/.exec(s)![1]!.split(",").map(Number);
    expect(list).toContain(1); // ICMPv4
    expect(list).toContain(58); // ICMPv6
    expect(list).toContain(47); // GRE
    expect(list).toContain(0);
    expect(list).toContain(255);
    expect(list).not.toContain(6);
    expect(list).not.toContain(17);
    expect(list).toHaveLength(254);
  });

  it("reads every rule back and fails closed on a mismatch, before the marker", () => {
    const s = windowsBootstrapScript({ vpcCidr: CIDR });
    const check = s.indexOf(`if ($rules.Count -ne ${WINDOWS_BOOTSTRAP_RULE_COUNT}) { exit 1 }`);
    const marker = s.indexOf(BOOTSTRAP_OK_MARKER);
    expect(check).toBeGreaterThan(-1);
    expect(s).toContain("$_.Enabled -eq 'True' -and $_.Action -eq 'Block'");
    expect(marker).toBeGreaterThan(check);
    expect(s).toContain("C:\\ProgramData\\tc-isolation.ok");
  });

  it("is deterministic and holds no customer text", () => {
    expect(windowsBootstrapScript({ vpcCidr: CIDR })).toBe(
      windowsBootstrapScript({ vpcCidr: CIDR }),
    );
  });
});
