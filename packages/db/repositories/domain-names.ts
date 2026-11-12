import { sql } from "drizzle-orm";
import type { Tx } from "../client";

// WP7-T4: who holds a domain name and a hosted zone, across customers. A name is one thing in the whole
// platform (it is registered once in tc-dns), so these two reads have no customer id and return ids and
// booleans only: never a row of another customer (R8). They are for the purchase transaction
// (web_rw) and for the provisioner (worker_rw); both roles can SELECT the columns used here.

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ZONE = /^[A-Z0-9]{1,32}$/;

/**
 * The resource of the earliest order for the name that has not failed (a failed create is reversed and
 * gives the name back), or `null` when none holds it. The order of two orders for one name is the order
 * of their rows, which the database fixes, so every caller reaches the same answer.
 */
export async function domainNameHolder(tx: Tx, name: string): Promise<string | null> {
  if (typeof name !== "string" || name.length > 253 || !NAME.test(name)) {
    throw new TypeError("domainNameHolder: not a domain name");
  }
  const result = await tx.execute(sql`
    select d.resource_id as "resourceId"
    from domains d join resources r on r.id = d.resource_id
    where d.name = ${name} and r.state <> 'failed'
    order by d.created_at, d.id
    limit 1`);
  const row = result.rows[0] as { resourceId?: unknown } | undefined;
  return typeof row?.resourceId === "string" ? row.resourceId : null;
}

/**
 * WPU-G6: the resource of the earliest live DNS zone for the name (a failed or removed zone gives the
 * name back), or `null` when none holds it. Same rule as a domain: one zone name is one thing on the
 * platform, and the answer is an id, never a row of another customer (R8).
 */
export async function dnsZoneNameHolder(tx: Tx, name: string): Promise<string | null> {
  if (typeof name !== "string" || name.length > 253 || !NAME.test(name)) {
    throw new TypeError("dnsZoneNameHolder: not a zone name");
  }
  const result = await tx.execute(sql`
    select z.resource_id as "resourceId"
    from dns_zones z join resources r on r.id = z.resource_id
    where z.name = ${name} and z.status not in ('removed', 'failed') and r.state <> 'failed'
    order by z.created_at, z.id
    limit 1`);
  const row = result.rows[0] as { resourceId?: unknown } | undefined;
  return typeof row?.resourceId === "string" ? row.resourceId : null;
}

/** True when a resource other than `resourceId` records this hosted zone in its config. */
export async function hostedZoneHeldByOther(
  tx: Tx,
  hostedZoneId: string,
  resourceId: string,
): Promise<boolean> {
  if (typeof hostedZoneId !== "string" || !ZONE.test(hostedZoneId)) {
    throw new TypeError("hostedZoneHeldByOther: not a hosted zone id");
  }
  const result = await tx.execute(sql`
    select 1 from resources
    where id <> ${resourceId}::uuid and config ->> 'hostedZoneId' = ${hostedZoneId}
    limit 1`);
  return result.rows.length > 0;
}
