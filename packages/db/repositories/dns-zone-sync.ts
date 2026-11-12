import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { insertOperation } from "../operations/insert";
import { lifecycleRepo } from "./system/lifecycle";

// WPU-G6: what the provisioner writes on the `dns_zones` row when the operations of the zone end
// (worker_rw has UPDATE on hosted_zone_id, name_servers, delegated_at, status). Both run inside the
// transaction of the state change, by resource id; a resource that is no zone matches no row. No customer
// id: the worker acts for the platform and the resource id is the key (R8 is for the customer tier).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONE = /^[A-Z0-9]{1,32}$/;
const NAME_SERVER = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.?$/i;

function requireResource(resourceId: string, who: string): void {
  if (typeof resourceId !== "string" || !UUID.test(resourceId)) {
    throw new TypeError(`${who}: resourceId is not a UUID`);
  }
}

/**
 * After the create step: the hosted zone id and the name servers the adapter saved in the resource
 * config move to the row, and the zone waits for delegation. A config that does not hold a well-formed
 * zone id and one to eight name servers changes nothing and returns false (R16). Returns true when a
 * row was changed. A zone that is already delegated keeps its word.
 */
export async function recordDnsZoneCreated(tx: Tx, resourceId: string): Promise<boolean> {
  requireResource(resourceId, "recordDnsZoneCreated");
  const found = await tx.execute(sql`
    select r.config as "config" from dns_zones z join resources r on r.id = z.resource_id
    where z.resource_id = ${resourceId}`);
  const config = (found.rows[0] as { config?: unknown } | undefined)?.config;
  if (typeof config !== "object" || config === null) return false;
  const { hostedZoneId, nameServers } = config as Record<string, unknown>;
  if (typeof hostedZoneId !== "string" || !ZONE.test(hostedZoneId)) return false;
  if (
    !Array.isArray(nameServers) ||
    nameServers.length < 1 ||
    nameServers.length > 8 ||
    !nameServers.every((n) => typeof n === "string" && NAME_SERVER.test(n))
  ) {
    return false;
  }
  const servers = (nameServers as string[]).map((n) => n.replace(/\.$/, "").toLowerCase());
  const list = sql.join(
    servers.map((s) => sql`${s}`),
    sql`, `,
  );
  const done = await tx.execute(sql`
    update dns_zones set hosted_zone_id = ${hostedZoneId},
      name_servers = ARRAY[${list}]::text[],
      status = case when status = 'delegated' then status else 'pending_delegation' end
    where resource_id = ${resourceId} and status in ('pending', 'pending_delegation', 'delegated')`);
  return done.rowCount === 1;
}

/** The create failed (and was reversed) or the zone is being removed or was removed. */
export async function markDnsZone(
  tx: Tx,
  resourceId: string,
  status: "failed" | "removed" | "removing",
): Promise<boolean> {
  requireResource(resourceId, "markDnsZone");
  if (status !== "failed" && status !== "removed" && status !== "removing") {
    throw new TypeError("markDnsZone: not a status the worker may set");
  }
  const done = await tx.execute(sql`
    update dns_zones set status = ${status}
    where resource_id = ${resourceId} and status not in ('removed', 'failed')`);
  return done.rowCount === 1;
}

// ---- WPU-D4 (audit C.24): the delegation job of the scheduler ------------------------------------
// worker_rw reads dns_zones and updates status, delegated_at and notices_sent_at. Each function is one
// compare-and-set on the state it expects, so a repeat of the job changes nothing (R7). The zone name is
// the only hostname the job ever looks up; it comes from the row, never from a request (R11).

export interface PendingDnsZone {
  readonly id: string;
  readonly resourceId: string;
  readonly customerId: string;
  readonly name: string;
  readonly nameServers: readonly string[];
  readonly createdAt: Date;
  readonly noticesSentAt: readonly Date[];
}

function requireZone(zoneId: string, who: string): void {
  if (typeof zoneId !== "string" || !UUID.test(zoneId)) {
    throw new TypeError(`${who}: zoneId is not a UUID`);
  }
}

/** The oldest zones that wait for delegation, at most `limit` (1 to 1000). */
export async function listDnsZonesPendingDelegation(
  tx: Tx,
  limit: number,
): Promise<PendingDnsZone[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("listDnsZonesPendingDelegation: the limit is not 1 to 1000");
  }
  const found = await tx.execute(sql`
    select id, resource_id as "resourceId", customer_id as "customerId", name,
      to_jsonb(name_servers) as "nameServers", created_at as "createdAt",
      to_jsonb(notices_sent_at) as "noticesSentAt"
    from dns_zones where status = 'pending_delegation'
    order by created_at, id limit ${limit}`);
  return (
    found.rows as {
      id: string;
      resourceId: string;
      customerId: string;
      name: string;
      nameServers: string[];
      createdAt: Date | string;
      noticesSentAt: (Date | string)[] | null;
    }[]
  ).map((r) => ({
    id: r.id,
    resourceId: r.resourceId,
    customerId: r.customerId,
    name: r.name,
    nameServers: r.nameServers,
    createdAt: new Date(r.createdAt),
    noticesSentAt: (r.noticesSentAt ?? []).map((d) => new Date(d)),
  }));
}

/**
 * pending_delegation -> delegated, with the time. False when the zone is in another state, or when
 * another zone already holds the same name delegated (WPU-S1 allows one): then it stays pending.
 */
export async function markDnsZoneDelegated(tx: Tx, zoneId: string, now: Date): Promise<boolean> {
  requireZone(zoneId, "markDnsZoneDelegated");
  const done = await tx.execute(sql`
    update dns_zones z set status = 'delegated', delegated_at = ${now.toISOString()}::timestamptz
    where z.id = ${zoneId} and z.status = 'pending_delegation'
      and not exists (select 1 from dns_zones d
        where d.name = z.name and d.status = 'delegated' and d.id <> z.id)`);
  return done.rowCount === 1;
}

/**
 * Records `add` notices (1 or 2) sent now, when the row still holds exactly `sentBefore` of them. The
 * notice and this write belong to one transaction, so a notice is written once (R7). False for a replay
 * or a zone that is no longer waiting.
 */
export async function recordDnsZoneNotices(
  tx: Tx,
  zoneId: string,
  sentBefore: number,
  add: number,
  now: Date,
): Promise<boolean> {
  requireZone(zoneId, "recordDnsZoneNotices");
  if (
    !Number.isInteger(sentBefore) ||
    !Number.isInteger(add) ||
    sentBefore < 0 ||
    add < 1 ||
    sentBefore + add > 2
  ) {
    throw new RangeError("recordDnsZoneNotices: the counts are not valid");
  }
  const stamp = now.toISOString();
  const done = await tx.execute(sql`
    update dns_zones
    set notices_sent_at = notices_sent_at || array_fill(${stamp}::timestamptz, ARRAY[${add}]::int[])
    where id = ${zoneId} and status = 'pending_delegation'
      and coalesce(cardinality(notices_sent_at), 0) = ${sentBefore}`);
  return done.rowCount === 1;
}

export interface RetiredDnsZone {
  readonly resourceId: string;
  readonly operationId: string;
  readonly created: boolean;
  readonly state: string;
  readonly enqueueSeq: number;
}

/**
 * The removal of a zone that was not delegated in time: under lock, the subscription becomes
 * `retained` (the guard of R13 then lets the destroy pass), the zone becomes `removing`, and ONE
 * destroy operation is queued with a key of the zone. Until 2026-12-01 it waits for an admin
 * (insertOperation applies the approval gate). Writes nothing in the ledger: the wallet is not touched.
 * Null (and no change) when the zone is not waiting for delegation any more, or has no live
 * subscription (R16).
 */
export async function retireUndelegatedDnsZone(
  tx: Tx,
  zoneId: string,
  now: Date,
): Promise<RetiredDnsZone | null> {
  requireZone(zoneId, "retireUndelegatedDnsZone");
  const zone = await tx.execute(sql`
    select resource_id as "resourceId" from dns_zones
    where id = ${zoneId} and status = 'pending_delegation' for update`);
  const resourceId = (zone.rows[0] as { resourceId?: string } | undefined)?.resourceId;
  if (resourceId === undefined) return null;
  const subscription = await tx.execute(sql`
    select id, status from subscriptions where resource_id = ${resourceId} for update`);
  const sub = subscription.rows[0] as { id: string; status: string } | undefined;
  if (sub === undefined || (sub.status !== "active" && sub.status !== "grace")) return null;

  const inserted = await insertOperation(
    tx,
    {
      resourceId,
      kind: "destroy",
      payload: { reason: "undelegated" },
      idempotencyKey: `dns-undelegated:${zoneId}`,
    },
    now,
  );
  await lifecycleRepo(tx).setStatus(sub.id, "retained");
  await tx.execute(sql`update dns_zones set status = 'removing' where id = ${zoneId}`);
  return {
    resourceId,
    operationId: inserted.operationId,
    created: inserted.created,
    state: inserted.state,
    enqueueSeq: inserted.enqueueSeq,
  };
}
