import type { CustomerSession } from "@tc/auth";
import {
  checkChange,
  validateRecord,
  validateRecordKey,
  validateZoneName,
  type RecordChange,
  type ValidRecord,
} from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  OperationsRepo,
  RateLimitsRepo,
  ResourcesRepo,
} from "@tc/db";
import { z } from "zod";
import { formDigits, formObject, formText } from "./form-schema.ts";

// The core of the Server Action of the DNS record editor (/dns/[id], WPU-G4). R9 order: authenticate,
// authorize (the ownership of the zone and the flag, R8 and R12), validate, rate limit, execute, audit.
// The change is an operation row of the kind change_dns_record (R1: nothing here calls AWS); the zone
// adapter validates the payload again. The idempotency key is the request id of the page plus a digest
// of the payload, so a repeat of the same form is one change and a different record is another (R7).
// What leaves the core is a fixed public key and the field codes of packages/core/dns (U6, R14).

export interface DnsOpsRepos {
  resources: ResourcesRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  /** R12, R16: the dns_zone flag for the customer's market; false when it cannot be read. */
  dnsOn(): Promise<boolean>;
}

export interface DnsOpsDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: DnsOpsRepos) => Promise<T>): Promise<T>;
}

export type DnsOpsError =
  | "unauthenticated"
  | "flag_off"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_allowed"
  | "busy"
  | "conflict"
  | "limit_reached"
  | "unavailable";

export type DnsOpsResult =
  | { ok: true; done: "added" | "changed" | "removed" }
  | { ok: false; error: DnsOpsError; fields?: Record<string, string> };

export const DNS_FAMILY = "dns_zone";
export const DNS_CHANGE_LIMIT: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "dns.change", limit: 60, windowSeconds: 3600 }),
]);

const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_VALUES_TEXT = 8192;

// R9: the shape and the closed lists are checked with zod before anything is read. The rules of a
// record (types, names, values) are in packages/core/dns, one source for each rule.
const form = formObject({
  zoneId: formText.pipe(z.string().regex(UUID)),
  requestId: formText.pipe(z.string().regex(UUID)),
  mode: formText.pipe(z.enum(["create", "upsert", "delete"])),
  name: formText.pipe(z.string().max(255)),
  type: formText.pipe(z.string().max(8)),
  ttl: formDigits(6),
  values: formText.pipe(z.string().max(MAX_VALUES_TEXT)),
}).superRefine((value, ctx) => {
  // A delete names the record only; the other modes need a TTL that is a number.
  if (value.mode !== "delete" && !Number.isFinite(value.ttl)) {
    ctx.addIssue({ code: "custom", path: ["ttl"], message: "ttl" });
  }
});

class Refusal extends Error {
  constructor(
    readonly error: DnsOpsError,
    readonly fields?: Record<string, string>,
  ) {
    super(error);
  }
}

const fail = (error: DnsOpsError, fields?: Record<string, string>): DnsOpsResult => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

/** One value on each line; blank lines are dropped. */
export function splitValues(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A digest of the payload for the idempotency key (FNV-1a, 32 bit). Not a security function. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

interface Mirror {
  fqdn: string;
  type: string;
}

/** The record sets that the page showed: the list kept on the zone by the last change (R16). */
export function mirrorSets(config: unknown): Mirror[] | null {
  if (typeof config !== "object" || config === null) return null;
  const c = config as Record<string, unknown>;
  if (c["recordsStale"] === true) return null;
  const records = c["records"];
  if (records === undefined) return [];
  if (!Array.isArray(records)) return null;
  const out: Mirror[] = [];
  for (const r of records as unknown[]) {
    if (typeof r !== "object" || r === null) return null;
    const { name, type } = r as Record<string, unknown>;
    if (typeof name !== "string" || typeof type !== "string") return null;
    out.push({ fqdn: name, type });
  }
  return out;
}

export async function changeRecordCore(deps: DnsOpsDeps, raw: unknown): Promise<DnsOpsResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");

  const parsed = form.safeParse(raw);
  if (!parsed.success) return fail("validation");
  const input = parsed.data;

  try {
    return await deps.store(session.customerId, async (repos) => {
      // Authorize: the zone is the customer's own (null for another customer's, R8) and the flag is on.
      const zone = await repos.resources.get(input.zoneId);
      if (zone === null || zone.family !== DNS_FAMILY) throw new Refusal("not_found");
      if (!(await repos.dnsOn())) throw new Refusal("flag_off");

      const config = (
        typeof zone.config === "object" && zone.config !== null ? zone.config : {}
      ) as Record<string, unknown>;
      const zoneName = validateZoneName(config["zoneName"]);
      const sets = mirrorSets(config);
      // A zone that is not active, has no hosted zone yet or whose list cannot be trusted is not edited.
      if (
        !zoneName.ok ||
        zone.state !== "active" ||
        typeof config["hostedZoneId"] !== "string" ||
        sets === null
      ) {
        throw new Refusal("not_allowed");
      }

      // Validate with the rules of the core: the same function the adapter runs again.
      const values = splitValues(input.values);
      let record: ValidRecord;
      let payload: Record<string, unknown>;
      let change: RecordChange["action"];
      if (input.mode === "delete") {
        const key = validateRecordKey(zoneName.value, input.name, input.type);
        if (!key.ok) throw new Refusal("validation", key.fields);
        change = "delete";
        record = {
          fqdn: key.value.fqdn,
          type: key.value.type,
          ttl: 60,
          values: ["-"],
          isApex: key.value.isApex,
        };
        payload = { change, name: record.fqdn, type: record.type };
      } else {
        const checked = validateRecord(zoneName.value, {
          name: input.name,
          type: input.type,
          ttl: input.ttl,
          values,
        });
        if (!checked.ok) throw new Refusal("validation", checked.fields);
        change = input.mode;
        record = checked.value;
        payload = {
          change,
          name: record.fqdn,
          type: record.type,
          ttl: record.ttl,
          values,
        };
      }
      // The rules that need the other record sets: apex NS and SOA, a CNAME alone at its name, the limit.
      const rules = checkChange(zoneName.value, sets, { action: change, record });
      if (!rules.ok) {
        const fields = "fields" in rules ? rules.fields : undefined;
        if (rules.error === "not_found") throw new Refusal("not_found");
        if (rules.error === "conflict") throw new Refusal("conflict", fields);
        if (rules.error === "limit_reached") throw new Refusal("limit_reached", fields);
        throw new Refusal("validation", fields);
      }

      const decision = await repos.rateLimits.consume(DNS_CHANGE_LIMIT, deps.now());
      if (!decision.allowed) return fail("rate_limited");

      // Two changes made from the same list would overwrite each other: one at a time.
      const before = await repos.operations.listForResource(zone.id);
      if (before.some((o) => o.kind === "change_dns_record" && IN_FLIGHT.includes(o.state))) {
        throw new Refusal("busy");
      }
      const written = await repos.operations.request({
        resourceId: zone.id,
        kind: "change_dns_record",
        idempotencyKey: `dns.change:${input.requestId}:${digest(JSON.stringify(payload))}`,
        payload,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      if (!written.replayed) {
        // The row was just written: if another change is on its way, this transaction is rolled back.
        const others = await repos.operations.listForResource(zone.id);
        const busy = others.some(
          (o) =>
            o.id !== written.value.id &&
            o.kind === "change_dns_record" &&
            IN_FLIGHT.includes(o.state),
        );
        if (busy) throw new Refusal("busy");
      }
      const audited = await repos.audit.record({
        action: "dns.change_record",
        targetType: "resource",
        targetId: zone.id,
      });
      // The audit entry is part of the action: without it everything rolls back (R9, R16).
      if (!audited.ok) throw new Error("dns-actions: the audit entry was refused");
      return {
        ok: true,
        done: change === "create" ? "added" : change === "upsert" ? "changed" : "removed",
      } satisfies DnsOpsResult;
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error, error.fields) : fail("unavailable");
  }
}
