import { BOOTSTRAP_FAIL_CLOSED_CIDRS, BOOTSTRAP_OK_MARKER, isValidCidr } from "./bootstrap";

// 10.4 item 2: the bootstrap firewall of a Windows instance, as EC2Launch-style user data (a fixed
// template; its only inputs are a checked CIDR and one boolean, so no customer text can reach it,
// R11). Same stance as the Linux bootstrap: fail closed. Windows Firewall lets a block rule win over
// an allow rule, so the exemptions are written into the block rules themselves:
//  - TCP: every port is blocked from the private sources; port 80 only by opt-in (a load balancer).
//  - UDP: every local port is blocked except 68. Local port 68 is blocked from every VPC source
//    except the one DHCP server address (`dhcpServer`): the exemption is keyed on the local port
//    and on the address, never on a source port, which the sender controls. Without a valid
//    address the script is strict: UDP 68 is blocked from all sources, and the marker is written
//    only if the interface still holds a DHCP lease. VERIFY on staging: Windows DHCP renewal in
//    strict mode, and the DHCP server address of the Lightsail subnet.
//  - every other IP protocol (ICMP and the rest, numbers 0-255 except 6 and 17) has a rule of its
//    own; one "any protocol" rule would also block DHCP, because a block rule beats an exemption.
// The marker is written only after every rule was read back: name, enabled, block, inbound. A rule
// that is missing means no marker, and the control plane does not hand the instance over (R16).
// VERIFY on every offered Windows blueprint (tests/isolation) that RDP from the public side works and
// the VPC side is closed; that user data runs on first boot, so the window before it ends is covered
// by Lightsail's own public-IP filter only (Linux closes it with a unit before the network); the size
// limit of user data with this many rules; the DHCP renewal from the VPC router.

export const WINDOWS_BOOTSTRAP_MARKER_FILE = "C:\\ProgramData\\tc-isolation.ok";
const RULE_PREFIX = "tc-isolation";
const OTHER_PROTOCOLS = Array.from({ length: 256 }, (_, n) => n).filter((n) => n !== 6 && n !== 17);

/** The number of block rules the script creates and reads back. */
export const WINDOWS_BOOTSTRAP_RULE_COUNT = 3 + OTHER_PROTOCOLS.length;

export interface WindowsBootstrapOptions {
  /** The verified VPC CIDR as a literal. Missing or invalid: every RFC 1918 source is blocked. */
  readonly vpcCidr?: string | null;
  /**
   * TCP 80 from the VPC CIDR, for an instance behind a Lightsail load balancer. Off by default.
   * Needs a valid `vpcCidr`: refused (throws) otherwise, so the fail-closed list never opens a port.
   */
  readonly allowLoadBalancerHttp?: boolean;
  /**
   * The DHCP server of the instance's subnet, an IPv4 address inside `vpcCidr`. Only UDP 68 from this
   * one address is let through; every other VPC source is blocked there, whatever its source port.
   * Missing, invalid or outside the CIDR: strict mode, UDP 68 is blocked from every source and the
   * script then checks that the interface still holds a DHCP lease, else it writes no marker (the
   * instance is not handed over as isolated-OK). Where the address comes from is a VERIFY item (the
   * router address of the subnet, base+1 by the AWS VPC rule: not guessed here).
   */
  readonly dhcpServer?: string | null;
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}
function intToIp(n: number): string {
  return [24, 16, 8, 0].map((sh) => Math.floor(n / 2 ** sh) % 256).join(".");
}

/** The address ranges of `cidr` without `ip`, or null when `ip` is not a plain IPv4 inside `cidr`. */
export function cidrWithout(cidr: string, ip: unknown): string[] | null {
  if (!isValidCidr(cidr) || typeof ip !== "string") return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split(".").some((o) => Number(o) > 255)) {
    return null;
  }
  const [base, bits] = cidr.split("/") as [string, string];
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipToInt(base) / size) * size;
  const end = start + size - 1;
  const at = ipToInt(ip);
  if (at < start || at > end) return null;
  const out: string[] = [];
  if (at > start) out.push(`${intToIp(start)}-${intToIp(at - 1)}`);
  if (at < end) out.push(`${intToIp(at + 1)}-${intToIp(end)}`);
  return out.length === 0 ? null : out;
}

/** The user data of every Windows instance. Any failure stops the script and writes no marker. */
export function windowsBootstrapScript(options: WindowsBootstrapOptions = {}): string {
  const http = options.allowLoadBalancerHttp === true;
  if (http && !isValidCidr(options.vpcCidr)) {
    throw new Error("bootstrap: port 80 needs a valid VPC CIDR");
  }
  const sources = isValidCidr(options.vpcCidr) ? [options.vpcCidr] : BOOTSTRAP_FAIL_CLOSED_CIDRS;
  const list = sources.map((s) => `'${s}'`).join(",");
  const tcpPorts = http ? "1-79,81-65535" : "1-65535";
  const protocols = OTHER_PROTOCOLS.join(",");
  const open = isValidCidr(options.vpcCidr)
    ? cidrWithout(options.vpcCidr, options.dhcpServer)
    : null;
  const dhcpSources = open === null ? "$sources" : `@(${open.map((r) => `'${r}'`).join(",")})`;
  return `<powershell>
$ErrorActionPreference = 'Stop'
$sources = @(${list})
Get-NetFirewallRule -DisplayName '${RULE_PREFIX}-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-tcp' -Direction Inbound -Action Block -Protocol TCP -LocalPort '${tcpPorts}' -RemoteAddress $sources -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-udp' -Direction Inbound -Action Block -Protocol UDP -LocalPort '1-67,69-65535' -RemoteAddress $sources -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-udp-dhcp' -Direction Inbound -Action Block -Protocol UDP -LocalPort '68' -RemoteAddress ${dhcpSources} -Profile Any | Out-Null
foreach ($p in @(${protocols})) {
  New-NetFirewallRule -DisplayName "${RULE_PREFIX}-proto-$p" -Direction Inbound -Action Block -Protocol $p -RemoteAddress $sources -Profile Any | Out-Null
}
$rules = @(Get-NetFirewallRule -DisplayName '${RULE_PREFIX}-*' | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' })
if ($rules.Count -ne ${WINDOWS_BOOTSTRAP_RULE_COUNT}) { exit 1 }
$lease = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' })
if ($lease.Count -lt 1) { exit 1 }
Set-Content -Path '${WINDOWS_BOOTSTRAP_MARKER_FILE}' -Value '${BOOTSTRAP_OK_MARKER}'
Write-Output '${BOOTSTRAP_OK_MARKER}'
</powershell>
`;
}
