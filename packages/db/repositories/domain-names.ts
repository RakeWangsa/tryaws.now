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
 * WPU-S1: the resource of the DELEGATED DNS zone for the name, or `null` when none is. Route 53 allows
 * several hosted zones with one name and a zone does nothing until the domain's NS records point at it,
 * so a pending zone holds nothing (migration 0012 has one delegated zone per name). The answer is an id,
 * never a row of another customer (R8).
 */
export async function dnsZoneNameHolder(tx: Tx, name: string): Promise<string | null> {
  if (typeof name !== "string" || name.length > 253 || !NAME.test(name)) {
    throw new TypeError("dnsZoneNameHolder: not a zone name");
  }
  const result = await tx.execute(sql`
    select z.resource_id as "resourceId"
    from dns_zones z join resources r on r.id = z.resource_id
    where z.name = ${name} and z.status = 'delegated' and r.state <> 'failed'
    order by z.created_at, z.id
    limit 1`);
  const row = result.rows[0] as { resourceId?: unknown } | undefined;
  return typeof row?.resourceId === "string" ? row.resourceId : null;
}

/** The name and every parent suffix of it that still has two labels, longest first (whole labels only). */
function nameAndParents(name: string): string[] {
  const labels = name.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * WPU-S1: does a domain registered on this platform hold the zone name? Checks the name itself and every
 * parent suffix by whole labels (`a.b.example.com` looks at `a.b.example.com`, `b.example.com` and
 * `example.com`; `notexample.com` is no suffix match). A domain whose create failed holds nothing.
 *  - `other`: a domain of ANOTHER customer is the name or a parent of it (the customer is refused);
 *  - `own`: the customer's own domain is exactly the name (its automatic zone is adopted, not created);
 *  - `null`: free, including a subdomain of the customer's own domain.
 * `other` wins over `own`. The answer is a word, never a row of another customer (R8).
 */
export async function zoneNameDomainHold(
  tx: Tx,
  name: string,
  customerId: string,
): Promise<"other" | "own" | null> {
  if (typeof name !== "string" || name.length > 253 || !NAME.test(name)) {
    throw new TypeError("zoneNameDomainHold: not a zone name");
  }
  const names = nameAndParents(name);
  const list = sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select d.name, (d.customer_id = ${customerId}::uuid) as "mine"
    from domains d join resources r on r.id = d.resource_id
    where d.name in (${list}) and r.state <> 'failed'`);
  let own = false;
  for (const row of result.rows as { name: string; mine: boolean }[]) {
    if (!row.mine) return "other";
    if (row.name === name) own = true;
  }
  return own ? "own" : null;
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
