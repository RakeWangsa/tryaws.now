import { describe, expect, it } from "vitest";
import { BOOTSTRAP_OK_MARKER } from "../adapters/bootstrap";
import {
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
    expect(s).toContain("-Protocol UDP -LocalPort '68' -RemotePort '0-66,68-65535'");
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
