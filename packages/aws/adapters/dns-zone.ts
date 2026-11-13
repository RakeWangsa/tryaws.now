import {
  DNS_MAX_TTL,
  DNS_MIN_TTL,
  DNS_RECORD_TYPES,
  checkChange,
  stepDone,
  validateRecord,
  validateRecordKey,
  validateZoneName,
  type Result,
  type StepResult,
  type ValidRecord,
} from "@tc/core";
import { AwsError } from "../errors";
import type { R53Change, R53RecordSet, Route53Port } from "./route53-port";
import type { LiveState, OpCtx, ProductAdapter } from "./types";
import { splitChangeBatches } from "./route53-limits";

// WP7-T3: Amazon Route 53 zones and records of the customers. Everything runs in the tc-dns account
// (hosted zones via STS, TcDnsProvisioner / TcDnsReader; VERIFY the role names against the real
// account). The adapter never builds an AWS name from customer text except the zone name the customer
// owns, which `validateZoneName` accepted (R11); the zone's comment is generated. It gets the Route 53
// client only through the injected port.

export interface DnsZoneConfig {
  readonly zoneName: string;
}

export interface DnsZoneDeps {
  /** The port for the tc-dns account. Built per call so that a failed build keeps nothing. */
  readonly route53: () => Route53Port;
}

function fail(code: "validation" | "internal"): AwsError {
  return new AwsError({ code, retryable: false });
}

function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "not_found";
}

const HOSTED_ZONE_ID = /^[A-Z0-9]{1,32}$/;

/** The id the create step saved in `resources.config`; null when there is none or it is malformed. */
function savedZoneId(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const id: unknown = (config as Record<string, unknown>).hostedZoneId;
  return typeof id === "string" && HOSTED_ZONE_ID.test(id) ? id : null;
}

const dot = (name: string): string => `${name}.`;
// Route 53 returns "*" as the octal escape \052 (VERIFY).
const plain = (name: string): string =>
  name.replace(/\.$/, "").replaceAll("\\052", "*").toLowerCase();

export interface ZoneRecordView {
  readonly fqdn: string;
  readonly type: string;
  readonly ttl: number;
  readonly values: readonly string[];
  /** The apex NS and SOA: shown, never changed (spec 12). */
  readonly readOnly: boolean;
}

function isApexReadOnly(zoneName: string, set: { fqdn: string; type: string }): boolean {
  return set.fqdn === zoneName && (set.type === "NS" || set.type === "SOA");
}

/** Every record set of the zone, for the editor. */
export async function listZoneRecords(
  port: Route53Port,
  hostedZoneId: string,
  zoneName: string,
): Promise<ZoneRecordView[]> {
  const sets = await port.listRecordSets(hostedZoneId);
  return sets.map((s) => {
    const fqdn = plain(s.name);
    return {
      fqdn,
      type: s.type,
      ttl: s.ttl,
      values: s.values,
      readOnly: isApexReadOnly(zoneName, { fqdn, type: s.type }),
    };
  });
}

export interface RecordChangeInput {
  readonly hostedZoneId: string;
  readonly zoneName: string;
  readonly action: "create" | "upsert" | "delete";
  readonly record: ValidRecord;
  readonly maxRecordSets?: number;
}

/**
 * One record change, re-checked here because the adapter must not trust its caller: the type is in the
 * list, the name is inside the zone, the TTL is in range, then `checkChange` against the live sets (apex
 * NS and SOA read-only, CNAME alone at its name, limit). One ChangeResourceRecordSets batch follows.
 */
export async function applyRecordChange(
  port: Route53Port,
  input: RecordChangeInput,
): Promise<Result<undefined>> {
  const { record, zoneName } = input;
  const typeOk = (DNS_RECORD_TYPES as readonly string[]).includes(record.type);
  const apexReadOnly =
    record.type === ("SOA" as string) || (record.fqdn === zoneName && record.type === "NS");
  if (apexReadOnly) return { ok: false, error: "forbidden", fields: { type: "apex_read_only" } };
  const shape =
    typeOk &&
    Number.isInteger(record.ttl) &&
    record.ttl >= DNS_MIN_TTL &&
    record.ttl <= DNS_MAX_TTL &&
    Array.isArray(record.values) &&
    record.values.length > 0 &&
    record.values.every((v) => typeof v === "string" && v.length > 0) &&
    typeof record.fqdn === "string" &&
    (record.fqdn === zoneName || record.fqdn.endsWith(`.${zoneName}`));
  if (!shape) return { ok: false, error: "validation" };

  let live: readonly R53RecordSet[];
  try {
    live = await port.listRecordSets(input.hostedZoneId);
  } catch (error) {
    if (isNotFound(error)) return { ok: false, error: "not_found" };
    throw error;
  }
  const existing = live.map((s) => ({ fqdn: plain(s.name), type: s.type }));
  const checked = checkChange(
    zoneName,
    existing,
    { action: input.action, record },
    input.maxRecordSets === undefined ? undefined : { maxRecordSets: input.maxRecordSets },
  );
  if (!checked.ok) return checked;

  let change: R53Change;
  if (input.action === "delete") {
    // Route 53 deletes only an exact copy of the live set.
    const set = live.find((s) => plain(s.name) === record.fqdn && s.type === record.type);
    if (set === undefined) return { ok: false, error: "not_found" };
    change = { action: "DELETE", set };
  } else {
    change = {
      action: input.action === "create" ? "CREATE" : "UPSERT",
      set: { name: dot(record.fqdn), type: record.type, ttl: record.ttl, values: record.values },
    };
  }
  try {
    await port.changeRecordSets(input.hostedZoneId, [change]);
  } catch (error) {
    if (error instanceof AwsError && error.code === "not_found")
      return { ok: false, error: "not_found" };
    if (error instanceof AwsError && error.code === "conflict")
      return { ok: false, error: "conflict" };
    throw error;
  }
  return { ok: true, value: undefined };
}

// ---- change_dns_record (WPU-G4) -----------------------------------------------------------------

const CHANGES = ["create", "upsert", "delete"] as const;
// The record list kept on the resource for the editor screen. The step patch holds 16 KB at most; the
// list stays well below it, or the screen is told that the list is stale and shows no records (R16).
const MIRROR_MAX_BYTES = 12_000;

interface MirrorRecord {
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly values: readonly string[];
  readonly readOnly?: true;
}

function mirrorOf(views: readonly ZoneRecordView[]): readonly MirrorRecord[] {
  return views.map((v) => ({
    name: v.fqdn,
    type: v.type,
    ttl: v.ttl,
    values: v.values,
    ...(v.readOnly ? { readOnly: true as const } : {}),
  }));
}

const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * One record change of the payload. The payload is written by the web tier, so it is input: it is
 * validated again with the rules of the core, and only what passed becomes a batch (R9, R11). The hosted
 * zone id comes from the resource, never from the payload. A repeat of a step that already succeeded
 * ends as done: a create whose set is already there with the same TTL and values, a delete whose set is
 * gone (R7).
 */
async function changeRecord(port: Route53Port, ctx: OpCtx<DnsZoneConfig>): Promise<StepResult> {
  const hostedZoneId = savedZoneId(ctx.resource.config);
  if (hostedZoneId === null) throw fail("validation");
  const payload: Record<string, unknown> =
    typeof ctx.operation.payload === "object" && ctx.operation.payload !== null
      ? (ctx.operation.payload as Record<string, unknown>)
      : {};
  const change = CHANGES.find((c) => c === payload.change);
  if (change === undefined) throw fail("validation");
  const zoneName = ctx.config.zoneName;

  let record: ValidRecord;
  if (change === "delete") {
    const key = validateRecordKey(zoneName, payload.name, payload.type);
    if (!key.ok) throw fail("validation");
    // Only the name and the type matter for a delete: Route 53 removes the exact live set (below).
    record = {
      fqdn: key.value.fqdn,
      type: key.value.type,
      ttl: DNS_MIN_TTL,
      values: ["-"],
      isApex: key.value.isApex,
    };
  } else {
    const checked = validateRecord(zoneName, {
      name: payload.name as string,
      type: payload.type as string,
      ttl: payload.ttl as number,
      values: payload.values as string[],
    });
    if (!checked.ok) throw fail("validation");
    record = checked.value;
  }

  const input: RecordChangeInput = { hostedZoneId, zoneName, action: change, record };
  const applied = await applyRecordChange(port, input);
  if (!applied.ok) {
    if (applied.error === "not_found" && change === "delete") {
      // A zone that is gone is not "already deleted": only a missing set is.
      if ((await port.getHostedZone(hostedZoneId)) === null) {
        throw new AwsError({ code: "not_found", retryable: false });
      }
    } else if (applied.error === "conflict" && change === "create") {
      const live = await port.listRecordSets(hostedZoneId);
      const there = live.find((s) => plain(s.name) === record.fqdn && s.type === record.type);
      if (
        there === undefined ||
        there.ttl !== record.ttl ||
        !sameValues(there.values, record.values)
      ) {
        throw fail("validation");
      }
    } else {
      throw fail("validation");
    }
  }

  return stepDone({ configMerge: await mirrorPatch(port, hostedZoneId, zoneName) });
}

/**
 * The record list kept on the resource for the editor: the live sets, or a stale mark when they do not
 * fit the step patch (the screen then says so and edits nothing, R16).
 */
async function mirrorPatch(
  port: Route53Port,
  hostedZoneId: string,
  zoneName: string,
): Promise<Record<string, unknown>> {
  const records = mirrorOf(await listZoneRecords(port, hostedZoneId, zoneName));
  const fits = Buffer.byteLength(JSON.stringify(records), "utf8") <= MIRROR_MAX_BYTES;
  return fits ? { records, recordsStale: false } : { records: null, recordsStale: true };
}

export function createDnsZoneAdapter(deps: DnsZoneDeps): ProductAdapter<DnsZoneConfig> {
  return {
    family: "dns_zone",
    parseConfig(input: unknown): DnsZoneConfig {
      const raw: unknown =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).zoneName
          : undefined;
      const name = validateZoneName(raw);
      if (!name.ok) throw fail("validation");
      return { zoneName: name.value };
    },
    aws: {
      // CreateHostedZone with the operation id as caller reference: a retry finds the same zone (spec 12).
      async create(ctx: OpCtx<DnsZoneConfig>): Promise<StepResult> {
        const port = deps.route53();
        const { zone } = await port.createHostedZone({
          name: ctx.config.zoneName,
          callerReference: ctx.operation.id,
          comment: `tc-dnszone-${ctx.resource.id.replaceAll("-", "").slice(16)}`,
        });
        // WPU-G6: the list is saved with the zone (apex NS and SOA, read-only), so the record editor of a
        // zone that was never changed shows what exists and can add the first record.
        return stepDone({
          state: "active",
          configMerge: {
            hostedZoneId: zone.id,
            nameServers: [...zone.nameServers],
            ...(await mirrorPatch(port, zone.id, ctx.config.zoneName)),
          },
        });
      },
      // A zone has nothing to suspend: its records stay (spec 11: DNS keeps its configuration).
      suspend: async () => stepDone(),
      resume: async () => stepDone(),
      finalSnapshot: async () => stepDone(),
      async destroy(ctx: OpCtx<DnsZoneConfig>): Promise<StepResult> {
        const id = savedZoneId(ctx.resource.config);
        if (id === null) return stepDone({ state: "destroyed" });
        const port = deps.route53();
        try {
          const sets = await port.listRecordSets(id);
          const doomed: R53Change[] = sets
            .filter(
              (s) => !isApexReadOnly(ctx.config.zoneName, { fqdn: plain(s.name), type: s.type }),
            )
            .map((set) => ({ action: "DELETE" as const, set }));
          // WPU-Z19: a full zone holds more than one request may (100 sets of 20 values is 2,000 elements): the
          // DELETEs go in batches under the limits. A retry lists the sets again, so what a batch already deleted
          // is not sent twice (R7).
          for (const batch of splitChangeBatches(doomed)) await port.changeRecordSets(id, batch);
          await port.deleteHostedZone(id);
        } catch (error) {
          if (!isNotFound(error)) throw error; // a step that deletes treats "not found" as done
        }
        return stepDone({ state: "destroyed" });
      },
      purgeSnapshots: async () => stepDone(),
      async describe(ctx: OpCtx<DnsZoneConfig>): Promise<LiveState> {
        const id = savedZoneId(ctx.resource.config);
        if (id === null) return { state: "missing" };
        const zone = await deps.route53().getHostedZone(id);
        return { state: zone === null ? "missing" : "active" };
      },
      async action(kind, ctx: OpCtx<DnsZoneConfig>): Promise<StepResult> {
        // The record editor (WPU-G4) is the one action of a zone; nothing else applies to it.
        if (kind !== "change_dns_record") throw fail("validation");
        return changeRecord(deps.route53(), ctx);
      },
    },
  };
}
