// Parsing of the admin IP allowlist (6.2: ops.<domain> is reachable only from the WAF allowlist).
// The list comes from the environment (TC_ADMIN_ALLOWLIST, comma separated CIDRs). Fail closed: an
// empty list, a malformed entry, a catch-all range or a very wide range is refused, because the
// allowlist is the only gate in front of the admin panel besides TOTP.
import { InfraConfigError } from "./stage";

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
  );
}

// No node:net here (the lib needs no Node types): the URL parser accepts a bracketed IPv6 literal
// only when it is valid.
function isIPv6(value: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(value) || !value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname !== "";
  } catch {
    return false;
  }
}

export interface Allowlist {
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}

// Widest range accepted. A /16 of IPv4 and a /32 of IPv6 are already generous for an office or a VPN.
const MIN_IPV4_PREFIX = 16;
const MIN_IPV6_PREFIX = 32;

export function parseAllowlist(raw: string): Allowlist {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new InfraConfigError("admin allowlist is empty");
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);
    if (prefixText !== undefined && !/^[0-9]{1,3}$/.test(prefixText)) {
      throw new InfraConfigError("admin allowlist entry has a bad prefix length");
    }
    if (isIPv4(address)) {
      const prefix = prefixText === undefined ? 32 : Number(prefixText);
      if (prefix > 32) throw new InfraConfigError("admin allowlist entry has a bad prefix length");
      if (prefix < MIN_IPV4_PREFIX) {
        throw new InfraConfigError("admin allowlist entry is too wide (narrower than /16 needed)");
      }
      ipv4.add(`${address}/${prefix}`);
    } else if (isIPv6(address)) {
      const prefix = prefixText === undefined ? 128 : Number(prefixText);
      if (prefix > 128) throw new InfraConfigError("admin allowlist entry has a bad prefix length");
      if (prefix < MIN_IPV6_PREFIX) {
        throw new InfraConfigError("admin allowlist entry is too wide (narrower than /32 needed)");
      }
      ipv6.add(`${address.toLowerCase()}/${prefix}`);
    } else {
      throw new InfraConfigError("admin allowlist entry is not an IP address");
    }
  }
  return { ipv4: [...ipv4].sort(), ipv6: [...ipv6].sort() };
}
