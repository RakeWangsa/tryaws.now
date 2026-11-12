import type { Result } from "../types";

// WPU-B2: the name servers of a registered domain (UpdateDomainNameservers). One rule for the web action
// and for the domain adapter, which validates the payload again because the web tier wrote it. Pure.
// Customer text reaches the registry here, so it is a closed shape: host names only (R11).

export const NAME_SERVERS_MIN = 2;
export const NAME_SERVERS_MAX = 8;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One host name, lower case, no trailing dot; null when it is not a plain host name (no IP address). */
function hostOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 254) return null;
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !HOST.test(host)) return null;
  // An IPv4 address is made of numeric labels only; a name server is a name.
  if (host.split(".").every((label) => /^\d+$/.test(label))) return null;
  return host;
}

export function parseNameServers(raw: unknown): Result<string[]> {
  const fail = { ok: false, error: "validation", fields: { nameServers: "invalid" } } as const;
  if (!Array.isArray(raw) || raw.length < NAME_SERVERS_MIN || raw.length > NAME_SERVERS_MAX) {
    return fail;
  }
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    const host = hostOf(item);
    if (host === null) return fail;
    out.push(host);
  }
  return new Set(out).size === out.length ? { ok: true, value: out } : fail;
}

/** The text of a form field: lines, commas or spaces between the names. */
export function splitNameServers(text: string): string[] {
  return text.split(/[\s,]+/).filter((part) => part.length > 0);
}
