import type { Result } from "../types";

// WP7-T4, spec 12: a domain name the customer types. Pure: no AWS, no clock, no throw. The only text that
// leaves this file is the ASCII name (letters, digits, hyphens) that passed every check below; it is the
// name the customer asked for and the registry needs, never an AWS resource name or a tag (R11). A refusal
// names a field and a constant code and never repeats the input (R14).

export const DOMAIN_MAX_NAME_LENGTH = 253;
export const DOMAIN_MAX_LABEL_LENGTH = 63;
const MAX_INPUT = 300;

export interface DomainName {
  /** The registered name in ASCII (punycode for an IDN), lower case, no trailing dot: `example.com`. */
  readonly name: string;
  /** The label in front of the TLD: `example`. */
  readonly label: string;
  /** The longest listed suffix that matches: `com`, `co.uk`. */
  readonly tld: string;
  /** True when the customer typed non-ASCII letters or a punycode label. */
  readonly idn: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Anything that is a URL, a path, an address or markup is refused before the host parser sees it.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s/\\:@?#%*_,;=+<>"'`()[\]{}|^~!$&\u0000-\u001f\u007f]/;
const ASCII = /^[\x20-\x7e]*$/;

const bad = (code: string): Result<never> => ({
  ok: false,
  error: "validation",
  fields: { name: code },
});

function toAscii(text: string): string | null {
  if (ASCII.test(text)) return text;
  try {
    // The URL parser applies IDNA (UTS 46) and punycode. Anything it cannot map throws.
    const host = new URL(`http://${text}`).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** `knownTlds` are the TLDs of the `tlds` table (lower case, without a dot). */
export function normalizeDomainName(
  raw: unknown,
  knownTlds: readonly string[],
): Result<DomainName> {
  if (typeof raw !== "string") return bad("invalid");
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT) return bad("invalid");
  if (FORBIDDEN.test(trimmed)) return bad("invalid");
  const unicode = !ASCII.test(trimmed);
  const withoutDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (withoutDot.length === 0 || withoutDot.startsWith(".") || withoutDot.includes("..")) {
    return bad("invalid");
  }
  const ascii = toAscii(withoutDot.toLowerCase());
  if (ascii === null) return bad("invalid");
  const name = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (name.length > DOMAIN_MAX_NAME_LENGTH) return bad("too_long");

  const labels = name.split(".");
  if (labels.length < 2) return bad("invalid");
  for (const label of labels) {
    if (label.length === 0) return bad("invalid");
    if (label.length > DOMAIN_MAX_LABEL_LENGTH) return bad("label_too_long");
    if (!LABEL.test(label)) return bad("invalid");
    // Hyphens in positions 3 and 4 belong to punycode only (RFC 5891, 4.2.3.1).
    if (label.slice(2, 4) === "--" && !label.startsWith("xn--")) return bad("invalid");
  }

  // The longest listed suffix wins (`co.uk` before `uk`); the rest must be exactly one label.
  const listed = [...knownTlds]
    .filter((tld) => name.endsWith(`.${tld}`))
    .sort((a, b) => b.length - a.length);
  const tld = listed[0];
  if (tld === undefined) return bad("tld_unsupported");
  const label = name.slice(0, name.length - tld.length - 1);
  if (label.length === 0 || label.includes(".")) return bad("invalid");
  return {
    ok: true,
    value: { name, label, tld, idn: unicode || labels.some((l) => l.startsWith("xn--")) },
  };
}
