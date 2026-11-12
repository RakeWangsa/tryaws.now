// The firewall rules of a server as the customer edits them (the Networking tab, WPU-G17). Pure logic:
// strict parsing of ports and sources, the presets of the Lightsail console, and the list operations.
// IPv4 only: the servers are created IPv4-only until the IPv6 isolation cases hold (spec 10.4), so an
// IPv6 source is refused with its own key and never stored. Nothing here knows an AWS name (R11).

export type FirewallProtocol = "tcp" | "udp" | "icmp";

export interface FirewallRule {
  readonly protocol: FirewallProtocol;
  /** tcp and udp: the first port. icmp: the type. */
  readonly fromPort: number;
  /** tcp and udp: the last port. icmp: the code (-1 for all). */
  readonly toPort: number;
  /** IPv4 CIDR blocks, "0.0.0.0/0" for any address. */
  readonly cidrs: readonly string[];
}

export const FIREWALL_MAX_RULES = 30;
export const FIREWALL_MAX_SOURCES = 20;
export const FIREWALL_ANYWHERE = "0.0.0.0/0";

export const FIREWALL_PRESETS = Object.freeze({
  ssh: Object.freeze({ protocol: "tcp", fromPort: 22, toPort: 22 }),
  http: Object.freeze({ protocol: "tcp", fromPort: 80, toPort: 80 }),
  https: Object.freeze({ protocol: "tcp", fromPort: 443, toPort: 443 }),
  rdp: Object.freeze({ protocol: "tcp", fromPort: 3389, toPort: 3389 }),
  ping: Object.freeze({ protocol: "icmp", fromPort: 8, toPort: -1 }),
} as const);

export type FirewallPresetName = keyof typeof FIREWALL_PRESETS;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_CIDR = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}(?:/(\\d|[12]\\d|3[0-2]))?$`);
const PORT_TEXT = /^\d{1,5}$/;

export type SourcesResult =
  { ok: true; cidrs: string[] } | { ok: false; error: "invalid" | "ipv6" | "too_many" };

/**
 * The sources field: addresses or CIDR blocks separated by commas, spaces or lines. No leading zeros
 * and no host names. A bare address becomes a /32.
 */
export function parseFirewallSources(text: unknown): SourcesResult {
  if (typeof text !== "string" || text.length > 2048) return { ok: false, error: "invalid" };
  const parts = text.split(/[\s,]+/u).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "invalid" };
  if (parts.length > FIREWALL_MAX_SOURCES) return { ok: false, error: "too_many" };
  const out: string[] = [];
  for (const part of parts) {
    if (part.includes(":")) return { ok: false, error: "ipv6" };
    if (!IPV4_CIDR.test(part)) return { ok: false, error: "invalid" };
    const cidr = part.includes("/") ? part : `${part}/32`;
    if (!out.includes(cidr)) out.push(cidr);
  }
  return { ok: true, cidrs: out };
}

function portOf(text: unknown): number | null {
  if (typeof text !== "string" || !PORT_TEXT.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= 65535 ? n : null;
}

export type NewRuleResult =
  { ok: true; rule: FirewallRule } | { ok: false; fields: Record<string, string> };

/**
 * The add-rule form: a preset (or "custom" with protocol and ports) and the sources ("any" is every
 * IPv4 address). Every field is checked and every wrong one is named, so the form can show it.
 */
export function parseNewFirewallRule(input: {
  preset?: unknown;
  protocol?: unknown;
  fromPort?: unknown;
  toPort?: unknown;
  sources?: unknown;
}): NewRuleResult {
  const fields: Record<string, string> = {};
  let shape: { protocol: FirewallProtocol; fromPort: number; toPort: number } | null = null;
  const preset = input.preset;
  if (typeof preset === "string" && Object.hasOwn(FIREWALL_PRESETS, preset)) {
    shape = { ...FIREWALL_PRESETS[preset as FirewallPresetName] };
  } else if (preset === "custom") {
    const protocol = input.protocol;
    if (protocol !== "tcp" && protocol !== "udp") fields["protocol"] = "invalid";
    const from = portOf(input.fromPort);
    const blankTo = typeof input.toPort !== "string" || input.toPort.trim() === "";
    const to = blankTo ? from : portOf(input.toPort);
    if (from === null) fields["fromPort"] = "invalid";
    if (!blankTo && to === null) fields["toPort"] = "invalid";
    if (from !== null && to !== null && from > to) fields["toPort"] = "invalid";
    if (Object.keys(fields).length === 0 && from !== null && to !== null) {
      shape = { protocol: protocol as FirewallProtocol, fromPort: from, toPort: to };
    }
  } else {
    fields["preset"] = "invalid";
  }
  const raw = typeof input.sources === "string" ? input.sources.trim() : input.sources;
  const sources =
    raw === "any" ? ({ ok: true, cidrs: [FIREWALL_ANYWHERE] } as const) : parseFirewallSources(raw);
  if (!sources.ok) fields["sources"] = sources.error;
  if (Object.keys(fields).length > 0 || shape === null || !sources.ok) {
    return { ok: false, fields };
  }
  return { ok: true, rule: { ...shape, cidrs: sources.cidrs } };
}

/** The identity of a rule inside a list: Lightsail keeps one rule per protocol and port range. */
export function firewallRuleKey(
  rule: Pick<FirewallRule, "protocol" | "fromPort" | "toPort">,
): string {
  return `${rule.protocol}:${rule.fromPort}-${rule.toPort}`;
}

export type ListResult =
  | { ok: true; rules: FirewallRule[] }
  | { ok: false; error: "duplicate" | "too_many" | "not_found" };

export function addFirewallRule(rules: readonly FirewallRule[], rule: FirewallRule): ListResult {
  if (rules.some((r) => firewallRuleKey(r) === firewallRuleKey(rule))) {
    return { ok: false, error: "duplicate" };
  }
  if (rules.length >= FIREWALL_MAX_RULES) return { ok: false, error: "too_many" };
  return { ok: true, rules: [...rules, rule] };
}

export function removeFirewallRule(rules: readonly FirewallRule[], key: string): ListResult {
  const kept = rules.filter((r) => firewallRuleKey(r) !== key);
  if (kept.length === rules.length) return { ok: false, error: "not_found" };
  return { ok: true, rules: kept };
}

/** True when a TCP rule that covers port 22 is open to every address (the console's warning). */
export function rulesOpenSshToWorld(rules: readonly FirewallRule[]): boolean {
  return rules.some(
    (r) =>
      r.protocol === "tcp" &&
      r.fromPort <= 22 &&
      r.toPort >= 22 &&
      r.cidrs.includes(FIREWALL_ANYWHERE),
  );
}

/**
 * A stored or requested list, validated again before it reaches AWS (the payload is input, R9). Only
 * the four known fields are copied. null for anything that is not a valid list.
 */
export function parseFirewallRules(input: unknown): FirewallRule[] | null {
  if (!Array.isArray(input) || input.length > FIREWALL_MAX_RULES) return null;
  const out: FirewallRule[] = [];
  for (const raw of input as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const { protocol, fromPort, toPort, cidrs } = raw as Record<string, unknown>;
    if (protocol !== "tcp" && protocol !== "udp" && protocol !== "icmp") return null;
    if (!Number.isInteger(fromPort) || !Number.isInteger(toPort)) return null;
    const from = fromPort as number;
    const to = toPort as number;
    if (protocol === "icmp") {
      if (from < 0 || from > 255 || to < -1 || to > 255) return null;
    } else if (from < 0 || to > 65535 || from > to) {
      return null;
    }
    if (!Array.isArray(cidrs) || cidrs.length === 0 || cidrs.length > FIREWALL_MAX_SOURCES) {
      return null;
    }
    const clean: string[] = [];
    for (const c of cidrs as unknown[]) {
      if (typeof c !== "string" || !c.includes("/") || !IPV4_CIDR.test(c)) return null;
      clean.push(c);
    }
    out.push({ protocol, fromPort: from, toPort: to, cidrs: clean });
  }
  return out;
}
