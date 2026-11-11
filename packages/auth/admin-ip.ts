import { isIP } from "node:net";

// The IP allowlist of the admin app (6.2, R10) as pure functions. WAF is the first wall; this is the
// second, so a request that reaches the function without passing WAF is still refused. Everything
// here fails closed (R16): a header, address or list entry that cannot be read allows nothing.

const MAX_HEADER = 100;

// CloudFront-Viewer-Address: "<ip>:<port>". IPv6 arrives as "[ip]:port" or as "ip:port" (VERIFY the
// exact form on staging). Returns the bare address or null.
export function parseViewerAddress(header: string | null | undefined): string | null {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER) return null;
  let host: string;
  let port: string;
  if (header.startsWith("[")) {
    const close = header.indexOf("]:");
    if (close < 0) return null;
    host = header.slice(1, close);
    port = header.slice(close + 2);
  } else {
    const cut = header.lastIndexOf(":");
    if (cut < 0) return null;
    host = header.slice(0, cut);
    port = header.slice(cut + 1);
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return null;
  if (isIP(host) === 0) return null;
  // "a:b:c" read as host:port would also pass for "1.2.3.4:80:90" only if the host were an address.
  return host;
}

interface Block {
  readonly family: 4 | 6;
  readonly bits: bigint;
  readonly prefix: number;
}

const WIDTH = { 4: 32, 6: 128 } as const;

// An address as one integer; an IPv4-mapped IPv6 address (::ffff:a.b.c.d) becomes its IPv4 address.
function toBits(address: string): { family: 4 | 6; bits: bigint } | null {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    return { family: 4, bits: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1] !== undefined) return toBits(mapped[1]);
    // Expand "::" into zero groups.
    const [head = "", tail = ""] = address.split("::");
    const groups = (s: string): string[] => (s === "" ? [] : s.split(":"));
    const h = groups(head);
    const t = address.includes("::") ? groups(tail) : [];
    const all = address.includes("::")
      ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t]
      : h;
    if (all.length !== 8) return null;
    let bits = 0n;
    for (const g of all) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      bits = (bits << 16n) | BigInt(parseInt(g, 16));
    }
    return { family: 6, bits };
  }
  return null;
}

// "a.b.c.d/n", "x::/n" or a single address (a full-length prefix). Null for anything else.
export function parseCidr(text: string): Block | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 60) return null;
  const slash = text.indexOf("/");
  const address = slash < 0 ? text : text.slice(0, slash);
  const parsed = toBits(address);
  if (parsed === null) return null;
  const width = WIDTH[parsed.family];
  let prefix = width;
  if (slash >= 0) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return null;
    prefix = Number(raw);
    if (prefix > width) return null;
  }
  return { family: parsed.family, bits: parsed.bits, prefix };
}

// True only when the address parses and lies inside at least one parseable entry. An entry that does
// not parse is skipped (it can never allow), so a typo narrows the list and never widens it.
export function ipAllowed(address: string, cidrs: readonly string[]): boolean {
  if (typeof address !== "string" || !Array.isArray(cidrs)) return false;
  const ip = toBits(address);
  if (ip === null) return false;
  for (const entry of cidrs) {
    const block = parseCidr(entry);
    if (block === null || block.family !== ip.family) continue;
    const shift = BigInt(WIDTH[block.family] - block.prefix);
    if (block.bits >> shift === ip.bits >> shift) return true;
  }
  return false;
}
