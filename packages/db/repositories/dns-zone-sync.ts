import { sql } from "drizzle-orm";
import type { Tx } from "../client";

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
