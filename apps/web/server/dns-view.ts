import type { CustomerSession } from "@tc/auth";
import { editableValue, validateZoneName } from "@tc/core";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import { DNS_FAMILY } from "./dns-actions.ts";

// What /dns and /dns/[id] show (WPU-G4, Amazon Route 53), read through the repositories of the session's
// customer (R8): a zone of another customer answers like a missing one. The zone name is the customer's
// own text that passed validateZoneName (R11); the hosted zone id, the account and every AWS error text
// stay out (U6). The list of records is the one the last change saved on the zone (the adapter keeps it
// next to the live zone): it is shown only when it is whole, otherwise the page says so (R16). The name
// servers are shown because the customer needs them to delegate the domain.

const GONE = ["destroyed", "failed"];
const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];

export interface ZoneListItem {
  id: string;
  name: string;
  state: string;
  /** The record sets the customer can change; null when the list is not known. */
  recordCount: number | null;
}

export type ZoneListScreen =
  { state: "flag_off" } | { state: "empty" } | { state: "ready"; zones: ZoneListItem[] };

export interface RecordView {
  /** The full name without the trailing dot. */
  name: string;
  /** "@" for the apex, else the part before the zone name. */
  relative: string;
  type: string;
  ttl: number;
  /** As the customer types them (TXT chunks joined). */
  values: string[];
  readOnly: boolean;
}

export type ChangeWord = "working" | "done" | "failed";

export interface ZoneView {
  id: string;
  name: string;
  state: string;
  nameServers: string[];
  /** null when the list is not known (stale or malformed). */
  records: RecordView[] | null;
  recordsStale: boolean;
  /** A record change is still on its way. */
  busy: boolean;
  lastChange: ChangeWord | null;
  /** The zone is active, has its hosted zone, has a whole list and no change on its way. */
  canEdit: boolean;
  /** One id per render of the page: the idempotency key of the forms on it (R7). */
  requestId: string;
}

export type ZoneScreen = { state: "flag_off" } | { state: "ready"; zone: ZoneView };

/** "@" for the apex, the part before the zone name inside the zone, the full name otherwise. */
export function recordRelativeName(zone: string, name: string): string {
  if (name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function zoneNameOf(config: unknown): string | null {
  const name = validateZoneName(record(config)["zoneName"]);
  return name.ok ? name.value : null;
}

function readRecords(config: unknown, zone: string): RecordView[] | null {
  const c = record(config);
  if (c["recordsStale"] === true) return null;
  const raw = c["records"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: RecordView[] = [];
  for (const entry of raw as unknown[]) {
    const r = record(entry);
    if (
      typeof r["name"] !== "string" ||
      typeof r["type"] !== "string" ||
      typeof r["ttl"] !== "number" ||
      !Array.isArray(r["values"]) ||
      !(r["values"] as unknown[]).every((v) => typeof v === "string")
    ) {
      return null;
    }
    const type = r["type"];
    out.push({
      name: r["name"],
      relative: recordRelativeName(zone, r["name"]),
      type,
      ttl: r["ttl"],
      values: (r["values"] as string[]).map((v) => editableValue(type, v)),
      readOnly: r["readOnly"] === true,
    });
  }
  const rank = (r: RecordView): string => (r.relative === "@" ? "" : r.relative);
  return out.sort((a, b) => rank(a).localeCompare(rank(b)) || a.type.localeCompare(b.type));
}

function nameServersOf(config: unknown): string[] {
  const raw = record(config)["nameServers"];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((v): v is string => typeof v === "string" && /^[a-z0-9.-]{1,253}$/i.test(v))
    .map((v) => v.replace(/\.$/, ""))
    .slice(0, 8);
}

export async function loadZoneList(session: CustomerSession): Promise<ZoneListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    // R12, R16: a flag that is off or unreadable is off.
    if (profile === null || (await readFeatureFlag(tx, DNS_FAMILY, profile.market)) !== true) {
      return { state: "flag_off" };
    }
    const zones: ZoneListItem[] = [];
    for (const row of await repos.resources.list()) {
      if (row.family !== DNS_FAMILY || GONE.includes(row.state)) continue;
      const name = zoneNameOf(row.config);
      if (name === null) continue;
      const records = readRecords(row.config, name);
      zones.push({
        id: row.id,
        name,
        state: row.state,
        recordCount: records === null ? null : records.filter((r) => !r.readOnly).length,
      });
    }
    return zones.length === 0 ? { state: "empty" } : { state: "ready", zones };
  });
}

/** null for a missing zone and for another customer's zone alike (R8). */
export async function loadZone(
  session: CustomerSession,
  id: string,
  requestId: string,
): Promise<ZoneScreen | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const row = await repos.resources.get(id);
    if (row === null || row.family !== DNS_FAMILY || GONE.includes(row.state)) return null;
    const name = zoneNameOf(row.config);
    if (name === null) return null;
    const profile = await repos.profile.get();
    if (profile === null || (await readFeatureFlag(tx, DNS_FAMILY, profile.market)) !== true) {
      return { state: "flag_off" };
    }
    const changes = (await repos.operations.listForResource(id))
      .filter((o) => o.kind === "change_dns_record")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const busy = changes.some((o) => IN_FLIGHT.includes(o.state));
    const latest = changes[0];
    const lastChange: ChangeWord | null =
      latest === undefined
        ? null
        : IN_FLIGHT.includes(latest.state)
          ? "working"
          : latest.state === "succeeded"
            ? "done"
            : "failed";
    const config = record(row.config);
    const records = readRecords(row.config, name);
    return {
      state: "ready",
      zone: {
        id: row.id,
        name,
        state: row.state,
        nameServers: nameServersOf(row.config),
        records,
        recordsStale: config["recordsStale"] === true,
        busy,
        lastChange,
        canEdit:
          row.state === "active" &&
          typeof config["hostedZoneId"] === "string" &&
          records !== null &&
          !busy,
        requestId,
      },
    };
  });
}

/**
 * The record that `?edit=<TYPE>:<name>` names, taken from the list the page shows, or null. The
 * query is only a way to pick a row: nothing of it is used but the match (R11).
 */
export function pickEditing(
  zone: ZoneView,
  raw: unknown,
): { relative: string; type: string; ttl: number; values: string[] } | null {
  if (typeof raw !== "string" || zone.records === null || !zone.canEdit) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const type = raw.slice(0, at);
  const relative = raw.slice(at + 1);
  const found = zone.records.find((r) => !r.readOnly && r.type === type && r.relative === relative);
  return found === undefined
    ? null
    : { relative: found.relative, type: found.type, ttl: found.ttl, values: found.values };
}
