import { NotifyError } from "../queue/types";

// Strict field parsers. A template declares a closed list of fields; an unknown key (a `password`, a
// `token`, an `otp`) refuses the whole call, so nothing that is not declared reaches a payload or a
// message (R14, R16). What a parser returns is JSON: strings, booleans and numbers. Money is a
// decimal string of paisa (R4), a time is an ISO 8601 UTC string.

export type Parsed = string | number | boolean;
export interface Field {
  readonly parse: (value: unknown, name: string) => Parsed;
  readonly optional: boolean;
}

const bad = (name: string): never => {
  throw new NotifyError("bad_data", name);
};
// Control characters, zero-width characters and the bidirectional overrides that make text look like
// something else. Checked by code point, so no control character sits in a regular expression.
function hasForbiddenChar(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

const make = (parse: Field["parse"], optional = false): Field => ({ parse, optional });
const opt = (f: Field): Field => ({ parse: f.parse, optional: true });

const matching = (re: RegExp, max: number): Field =>
  make((v, n) => (typeof v === "string" && v.length <= max && re.test(v) ? v : bad(n)));

export const f = {
  uuid: matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36),
  minor: make((v, n) => {
    if (typeof v === "bigint" && v >= 0n) return v.toString();
    if (typeof v === "string" && /^[0-9]{1,18}$/.test(v)) return BigInt(v).toString();
    return bad(n);
  }),
  instant: make((v, n) => {
    const at = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
    if (at === null || Number.isNaN(at.getTime())) return bad(n);
    if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v))
      return bad(n);
    return at.toISOString();
  }),
  text: (max: number): Field =>
    make((v, n) => {
      if (typeof v !== "string") return bad(n);
      const t = v.trim();
      return t.length >= 1 && t.length <= max && !hasForbiddenChar(t) ? t : bad(n);
    }),
  // WPU-D4: text written by an admin for a customer (a support reply). Line breaks are kept (CRLF
  // becomes LF); every other control, zero-width and bidirectional-override character is refused.
  multiline: (max: number): Field =>
    make((v, n) => {
      if (typeof v !== "string") return bad(n);
      const t = v.replaceAll("\r\n", "\n").trim();
      return t.length >= 1 && t.length <= max && !hasForbiddenChar(t.replaceAll("\n", ""))
        ? t
        : bad(n);
    }),
  // WPU-D4: a plain machine key such as a product family ("linux_instance").
  key: matching(/^[a-z][a-z0-9_]{0,39}$/, 40),
  // 16.13: 1 to 40 characters, letters, digits, hyphen. Bengali needs the marks (vowel signs).
  label: matching(/^[\p{L}\p{M}\p{N}-]{1,40}$/u, 40),
  bool: make((v, n) => (typeof v === "boolean" ? v : bad(n))),
  oneOf: (...values: readonly (string | number)[]): Field =>
    make((v, n) => (values.includes(v as string | number) ? (v as Parsed) : bad(n))),
  region: matching(/^[a-z]{2}-[a-z]+-[0-9]$/, 20),
  address: matching(/^[A-Za-z0-9.:_-]{1,100}$/, 100),
  domain: matching(/^(?=.{3,80}$)([a-z0-9-]+\.)+[a-z0-9-]+$/i, 80),
  invoiceNumber: matching(/^[A-Z0-9-]{3,40}$/, 40),
  ip: matching(/^[0-9a-fA-F:.]{3,45}$/, 45),
  opt,
} as const;

export type Spec = Readonly<Record<string, Field>>;

export function parseData(spec: Spec, data: unknown): Record<string, Parsed> {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new NotifyError("bad_data");
  const input = data as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(spec, key)) throw new NotifyError("bad_data", key);
  }
  const out: Record<string, Parsed> = {};
  for (const [name, field] of Object.entries(spec)) {
    const v = input[name];
    if (v === undefined || v === null) {
      if (!field.optional) throw new NotifyError("bad_data", name);
      continue;
    }
    out[name] = field.parse(v, name);
  }
  return out;
}
