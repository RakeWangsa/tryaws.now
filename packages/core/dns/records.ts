import type { Result } from "../types";

// Spec 12: the record editor handles A, AAAA, CNAME, MX, TXT, NS, SRV and CAA; the apex NS and SOA are
// read-only. Pure: no AWS, no clock, no throw. The only customer text that leaves this file is the zone
// or record name the customer owns, after it passed the checks below (R11). A refusal names a field and a
// constant code; it never repeats the input (R14).

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const DNS_MIN_TTL = 60;
export const DNS_MAX_TTL = 86_400;
export const DNS_MAX_VALUES = 20;
export const DNS_MAX_NAME_LENGTH = 253;
export const DNS_MAX_LABEL_LENGTH = 63;
export const DNS_TXT_CHUNK = 255;
export const DNS_TXT_MAX = 4000;
// Record sets a customer may hold in one zone, apex NS and SOA not counted. A settings value may replace it.
export const DNS_DEFAULT_MAX_RECORD_SETS = 100;

export interface DnsRecordInput {
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly values: readonly string[];
}

/** A record that passed: `fqdn` has no trailing dot; `values` are in the wire form Route 53 takes. */
export interface ValidRecord {
  readonly fqdn: string;
  readonly type: DnsRecordType;
  readonly ttl: number;
  readonly values: readonly string[];
  readonly isApex: boolean;
}

type Fields = Record<string, string>;
const refuse = (fields: Fields): { ok: false; error: "validation"; fields: Fields } => ({
  ok: false,
  error: "validation",
  fields,
});

const ZONE_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
const MAX_LABEL = DNS_MAX_LABEL_LENGTH;

function labelsOk(labels: readonly string[], pattern: RegExp): "ok" | "label" | "label_too_long" {
  for (const label of labels) {
    if (label.length > MAX_LABEL) return "label_too_long";
    if (!pattern.test(label)) return "label";
  }
  return "ok";
}

/** A zone name: at least two letters-digits-hyphen labels, lower-cased, one trailing dot dropped. */
export function validateZoneName(input: unknown): Result<string> {
  if (typeof input !== "string") return refuse({ name: "invalid_name" });
  const name = (input.endsWith(".") ? input.slice(0, -1) : input).toLowerCase();
  if (name.length === 0 || name.length > DNS_MAX_NAME_LENGTH)
    return refuse({ name: "invalid_name" });
  const labels = name.split(".");
  if (labels.length < 2) return refuse({ name: "invalid_name" });
  if (labelsOk(labels, ZONE_LABEL) !== "ok") return refuse({ name: "invalid_name" });
  // The top-level label is never all digits: that is an IP address.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return refuse({ name: "invalid_name" });
  return { ok: true, value: name };
}

type NameResult =
  { ok: true; fqdn: string; isApex: boolean; relative: string[] } | { ok: false; code: string };

function normalizeName(zone: string, input: unknown): NameResult {
  if (typeof input !== "string") return { ok: false, code: "invalid_name" };
  let raw = input.toLowerCase();
  if (raw === "" || raw === "@") return { ok: true, fqdn: zone, isApex: true, relative: [] };
  if (raw.endsWith(".")) {
    raw = raw.slice(0, -1);
    // A trailing dot only means "absolute": the name must then be the zone or inside it.
    if (raw !== zone && !raw.endsWith(`.${zone}`)) return { ok: false, code: "invalid_name" };
  }
  if (raw === zone) return { ok: true, fqdn: zone, isApex: true, relative: [] };
  let relativeText = raw;
  if (raw.endsWith(`.${zone}`)) relativeText = raw.slice(0, -(zone.length + 1));
  else if (raw.split(".").pop() === zone.split(".").pop() && raw.includes(".")) {
    // Ends with the zone's top-level label but not with the zone: a full name of another zone.
    return { ok: false, code: "outside_zone" };
  }
  const relative = relativeText.split(".");
  const wildcard = relative[0] === "*";
  const checked = labelsOk(wildcard ? relative.slice(1) : relative, NAME_LABEL);
  if (checked !== "ok" || relative.slice(1).includes("*")) {
    return { ok: false, code: "invalid_name" };
  }
  const fqdn = `${relative.join(".")}.${zone}`;
  if (fqdn.length > DNS_MAX_NAME_LENGTH) return { ok: false, code: "too_long" };
  return { ok: true, fqdn, isApex: false, relative };
}

// ---- value checkers: each returns the wire form, or a constant code -------------------------------

type Value = { ok: true; value: string } | { ok: false; code: string };
const good = (value: string): Value => ({ ok: true, value });
const fail = (code: string): Value => ({ ok: false, code });

const IPV4_PART = /^(0|[1-9][0-9]{0,2})$/;
export function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((p) => IPV4_PART.test(p) && Number(p) <= 255);
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/;
function ipv6(text: string): string | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return null;
  let s = text.toLowerCase();
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    if (!isIpv4(s.slice(at + 1))) return null;
    s = `${s.slice(0, at + 1)}0:0`;
  }
  if (s.includes(":::")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === "") return [];
    const list = part.split(":");
    return list.every((g) => HEX_GROUP.test(g)) ? list : null;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const count = head.length + tail.length;
  if (halves.length === 2 ? count > 7 : count !== 8) return null;
  return text.toLowerCase();
}

/** A host name for a target: at least two labels, letters-digits-hyphen, not an IP address. Trailing dot dropped. */
function hostname(text: string): string | null {
  const host = (text.endsWith(".") ? text.slice(0, -1) : text).toLowerCase();
  if (host.length === 0 || host.length > DNS_MAX_NAME_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labelsOk(labels, ZONE_LABEL) !== "ok") return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  return host;
}

function uint16(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n <= 65_535 ? n : null;
}

function checkA(v: string): Value {
  return isIpv4(v) ? good(v) : fail("invalid_ipv4");
}
function checkAaaa(v: string): Value {
  const out = ipv6(v);
  return out === null ? fail("invalid_ipv6") : good(out);
}
function checkHostValue(v: string): Value {
  const host = hostname(v);
  return host === null ? fail("invalid_hostname") : good(host);
}
function checkMx(v: string): Value {
  const m = /^([0-9]+) +(\S+)$/.exec(v);
  if (m === null) return fail("invalid_mx");
  const pref = uint16(m[1]!);
  if (pref === null) return fail("invalid_priority");
  if (m[2] === ".") return pref === 0 ? good("0 .") : fail("invalid_mx");
  const host = hostname(m[2]!);
  return host === null ? fail("invalid_hostname") : good(`${pref} ${host}`);
}
function checkSrv(v: string): Value {
  const m = /^([0-9]+) +([0-9]+) +([0-9]+) +(\S+)$/.exec(v);
  if (m === null) return fail("invalid_srv");
  const nums = [m[1]!, m[2]!, m[3]!].map(uint16);
  if (nums.some((n) => n === null)) return fail("invalid_number");
  if (m[4] === ".") return good(`${nums.join(" ")} .`);
  const host = hostname(m[4]!);
  return host === null ? fail("invalid_hostname") : good(`${nums.join(" ")} ${host}`);
}
function checkTxt(v: string): Value {
  if (v.length === 0) return fail("empty");
  if (v.length > DNS_TXT_MAX) return fail("too_long");
  // Printable ASCII only (VERIFY: Route 53 takes other bytes only as octal escapes).
  if (!/^[\x20-\x7e]+$/.test(v)) return fail("invalid_char");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return fail("already_quoted");
  const chunks: string[] = [];
  let current = "";
  let length = 0;
  for (const ch of v) {
    if (length === DNS_TXT_CHUNK) {
      chunks.push(current);
      current = "";
      length = 0;
    }
    current += ch === '"' || ch === "\\" ? `\\${ch}` : ch;
    length += 1;
  }
  chunks.push(current);
  return good(chunks.map((c) => `"${c}"`).join(" "));
}
const CAA_TAGS = ["issue", "issuewild", "iodef"];
function checkCaa(v: string): Value {
  const m = /^(\S+) +(\S+) +(.+)$/.exec(v);
  if (m === null) return fail("invalid_caa");
  const flags = m[1]!;
  if (flags !== "0" && flags !== "128") return fail("invalid_flags");
  const tag = m[2]!;
  if (!CAA_TAGS.includes(tag)) return fail("invalid_tag");
  let value = m[3]!.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.length === 0 || value.length > 255) return fail("invalid_value");
  if (!/^[\x20-\x7e]+$/.test(value) || /["\\]/.test(value)) return fail("invalid_value");
  if (tag === "iodef") {
    if (!/^(mailto:[^\s@]+@[^\s@]+|https?:\/\/[^\s]+)$/.test(value)) return fail("invalid_value");
  } else {
    const [domain, ...params] = value.split(";");
    const d = domain!.trim();
    if (d !== "" && hostname(d) === null) return fail("invalid_value");
    for (const p of params) {
      const t = p.trim();
      if (t !== "" && !/^[A-Za-z0-9-]+=[\x21-\x7e]*$/.test(t)) return fail("invalid_value");
    }
  }
  return good(`${flags} ${tag} "${value}"`);
}

const CHECKERS: Readonly<Record<DnsRecordType, (v: string) => Value>> = Object.freeze({
  A: checkA,
  AAAA: checkAaaa,
  CNAME: checkHostValue,
  MX: checkMx,
  TXT: checkTxt,
  NS: checkHostValue,
  SRV: checkSrv,
  CAA: checkCaa,
});

function isType(type: unknown): type is DnsRecordType {
  return typeof type === "string" && (DNS_RECORD_TYPES as readonly string[]).includes(type);
}

/**
 * Checks one record for a zone. `zone` is a name that `validateZoneName` accepted. The result carries the
 * full name without trailing dot and the values in wire form; nothing of the input is kept otherwise.
 */
export function validateRecord(zone: string, input: DnsRecordInput): Result<ValidRecord> {
  const fields: Fields = {};
  const named = normalizeName(zone, input?.name);
  if (!named.ok) fields.name = named.code;
  if (!isType(input?.type)) {
    fields.type = "unsupported_type";
  }
  const ttl: unknown = input?.ttl;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < DNS_MIN_TTL || ttl > DNS_MAX_TTL) {
    fields.ttl = "out_of_range";
  }
  const type = isType(input?.type) ? input.type : null;
  if (named.ok && type !== null) {
    if (type === "CNAME" && named.isApex) fields.name = "apex_cname";
    if (type === "NS" && named.isApex) fields.name = "apex_read_only";
    if (type === "SRV") {
      const r = named.relative;
      const service = r.length >= 2 && r[0]!.startsWith("_") && r[1]!.startsWith("_");
      if (!service || r.slice(2).some((l) => l.startsWith("_"))) fields.name = "srv_name";
    }
  }
  const values: unknown = input?.values;
  const out: string[] = [];
  if (!Array.isArray(values) || values.length === 0) {
    fields.values = "required";
  } else if (values.length > DNS_MAX_VALUES) {
    fields.values = "too_many";
  } else if (type !== null) {
    values.forEach((raw: unknown, i) => {
      if (typeof raw !== "string") {
        fields[`values.${i}`] = "invalid_value";
        return;
      }
      const r = CHECKERS[type](raw);
      if (!r.ok) fields[`values.${i}`] = r.code;
      else out.push(r.value);
    });
    if (type === "CNAME" && values.length > 1) fields.values = "single_value";
    if (
      Object.keys(fields).every((k) => !k.startsWith("values")) &&
      new Set(out).size !== out.length
    ) {
      fields.values = "duplicate";
    }
    if (
      type === "CNAME" &&
      named.ok &&
      out.length === 1 &&
      out[0] === named.fqdn &&
      fields["values.0"] === undefined
    ) {
      fields["values.0"] = "points_at_itself";
    }
  }
  if (Object.keys(fields).length > 0 || !named.ok || type === null) return refuse(fields);
  return {
    ok: true,
    value: Object.freeze({
      fqdn: named.fqdn,
      type,
      ttl: ttl as number,
      values: Object.freeze(out),
      isApex: named.isApex,
    }),
  };
}

export interface RecordKey {
  readonly fqdn: string;
  readonly type: DnsRecordType;
  readonly isApex: boolean;
}

/**
 * The name and the type of a record set, for a delete: the same name and type rules as
 * `validateRecord`, and no values or TTL. The apex NS and any SOA are never a key (spec 12).
 */
export function validateRecordKey(zone: string, name: unknown, type: unknown): Result<RecordKey> {
  const fields: Fields = {};
  const named = normalizeName(zone, name);
  if (!named.ok) fields.name = named.code;
  if (!isType(type)) fields.type = "unsupported_type";
  if (named.ok && isType(type) && type === "NS" && named.isApex) fields.name = "apex_read_only";
  if (Object.keys(fields).length > 0 || !named.ok || !isType(type)) return refuse(fields);
  return {
    ok: true,
    value: Object.freeze({ fqdn: named.fqdn, type, isApex: named.isApex }),
  };
}

/**
 * What a customer types to get a stored value back: the chunks of a TXT value are joined and the
 * escapes removed (the inverse of the TXT checker); every other type is already in the form it was
 * typed in. A value that is not quoted text is returned as it is.
 */
export function editableValue(type: string, wire: string): string {
  if (type !== "TXT") return wire;
  const chunks: string[] = [];
  let rest = wire.trim();
  while (rest.length > 0) {
    if (!rest.startsWith('"')) return wire;
    let i = 1;
    let chunk = "";
    let closed = false;
    while (i < rest.length) {
      const ch = rest[i] as string;
      if (ch === "\\" && i + 1 < rest.length) {
        chunk += rest[i + 1];
        i += 2;
      } else if (ch === '"') {
        closed = true;
        i += 1;
        break;
      } else {
        chunk += ch;
        i += 1;
      }
    }
    if (!closed) return wire;
    chunks.push(chunk);
    rest = rest.slice(i).trimStart();
  }
  return chunks.length === 0 ? wire : chunks.join("");
}

export interface ExistingSet {
  readonly fqdn: string;
  readonly type: string;
}
export interface RecordChange {
  readonly action: "create" | "upsert" | "delete";
  readonly record: ValidRecord;
}

/**
 * The rules that need the other record sets of the zone: apex NS and SOA are read-only, a CNAME stands
 * alone at its name, the zone holds a limited number of record sets. `existing` is the live list.
 */
export function checkChange(
  zone: string,
  existing: readonly ExistingSet[],
  change: RecordChange,
  options?: { readonly maxRecordSets?: number },
): Result<undefined> {
  const { action, record } = change;
  const fqdn = record.fqdn.toLowerCase();
  const max = options?.maxRecordSets ?? DNS_DEFAULT_MAX_RECORD_SETS;
  if (record.type === ("SOA" as string) || (fqdn === zone && record.type === "NS")) {
    return { ok: false, error: "forbidden", fields: { type: "apex_read_only" } };
  }
  if (fqdn !== zone && !fqdn.endsWith(`.${zone}`)) return refuse({ name: "outside_zone" });
  const sets = existing.map((e) => ({
    fqdn: e.fqdn.toLowerCase().replace(/\.$/, ""),
    type: e.type,
  }));
  const isApexRead = (s: { fqdn: string; type: string }): boolean =>
    s.fqdn === zone && (s.type === "NS" || s.type === "SOA");
  const same = sets.some((s) => s.fqdn === fqdn && s.type === record.type);
  if (action === "delete") {
    return same ? { ok: true, value: undefined } : { ok: false, error: "not_found" };
  }
  if (action === "create" && same) {
    return { ok: false, error: "conflict", fields: { name: "exists" } };
  }
  const here = sets.filter((s) => s.fqdn === fqdn && !isApexRead(s));
  if (
    record.type === "CNAME"
      ? here.some((s) => s.type !== "CNAME")
      : here.some((s) => s.type === "CNAME")
  ) {
    return { ok: false, error: "conflict", fields: { name: "cname_conflict" } };
  }
  if (!same && sets.filter((s) => !isApexRead(s)).length >= max) {
    return { ok: false, error: "limit_reached", fields: { records: "zone_full" } };
  }
  return { ok: true, value: undefined };
}
