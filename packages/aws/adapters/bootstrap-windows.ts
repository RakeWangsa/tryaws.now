import { BOOTSTRAP_FAIL_CLOSED_CIDRS, BOOTSTRAP_OK_MARKER, isValidCidr } from "./bootstrap";

// 10.4 item 2: the bootstrap firewall of a Windows instance, as EC2Launch-style user data (a fixed
// template; its only input is a checked CIDR, so no customer text can reach it, R11). Windows
// Firewall lets a block rule win over an allow rule, so the rules block the private network on the
// port ranges around TCP 80 and UDP 68 and never on everything: UDP 68 is DHCP and TCP 80 stays
// available to the platform. VERIFY on every offered Windows blueprint (the isolation test of
// tests/isolation) that this keeps RDP from the public side working and the VPC side closed; a
// blueprint is listed only after its bootstrap passes. VERIFY the size limit and the run-once
// behavior of Lightsail user data on Windows.

export const WINDOWS_BOOTSTRAP_MARKER_FILE = "C:\\ProgramData\\tc-isolation.ok";
const RULE_PREFIX = "tc-isolation";
const TCP_PORTS = "1-79,81-65535";
const UDP_PORTS = "1-67,69-65535";

function sourcesOf(vpcCidr: unknown): readonly string[] {
  return isValidCidr(vpcCidr) ? [vpcCidr] : BOOTSTRAP_FAIL_CLOSED_CIDRS;
}

export interface WindowsBootstrapOptions {
  /** The verified VPC CIDR as a literal. Missing or invalid: every RFC 1918 source is blocked. */
  readonly vpcCidr?: string | null;
}

/** The user data of every Windows instance. Any failure stops the script and writes no marker. */
export function windowsBootstrapScript(options: WindowsBootstrapOptions = {}): string {
  const sources = sourcesOf(options.vpcCidr);
  const list = sources.map((s) => `'${s}'`).join(",");
  return `<powershell>
$ErrorActionPreference = 'Stop'
$sources = @(${list})
Get-NetFirewallRule -DisplayName '${RULE_PREFIX}-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-tcp' -Direction Inbound -Action Block -Protocol TCP -LocalPort '${TCP_PORTS}' -RemoteAddress $sources -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-udp' -Direction Inbound -Action Block -Protocol UDP -LocalPort '${UDP_PORTS}' -RemoteAddress $sources -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-icmp' -Direction Inbound -Action Block -Protocol ICMPv4 -RemoteAddress $sources -Profile Any | Out-Null
$rules = @(Get-NetFirewallRule -DisplayName '${RULE_PREFIX}-*' | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' })
if ($rules.Count -ne 3) { exit 1 }
Set-Content -Path '${WINDOWS_BOOTSTRAP_MARKER_FILE}' -Value '${BOOTSTRAP_OK_MARKER}'
Write-Output '${BOOTSTRAP_OK_MARKER}'
</powershell>
`;
}
