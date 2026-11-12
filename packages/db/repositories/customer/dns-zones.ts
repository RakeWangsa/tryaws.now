import { and, asc, eq, sql } from "drizzle-orm";
import { dnsZones } from "../../schema/index";
import { DNS_ZONE_STATUSES } from "../../schema/service";
import { created, refused, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// A DNS zone of the customer (WPU-G6). The customer id is not a field: the scope holds it (R8). The
// hosted zone id is not selected: web_rw has no grant on it and a screen never shows it (U6). The name
// servers are shown because the customer sets them at the registrar. The status words are
// `DNS_ZONE_STATES` of packages/core/dns.
export interface DnsZoneRow {
  id: string;
  resourceId: string;
  name: string;
  nameServers: string[];
  delegatedAt: Date | null;
  status: string;
  createdAt: Date;
}

export interface NewDnsZone {
  id: string;
  resourceId: string;
  name: string;
  status: string;
}

export interface DnsZonesRepo {
  list(): Promise<DnsZoneRow[]>;
  /** null for a missing row, a row of another customer and an id that is not a UUID alike (R8). */
  get(id: string): Promise<DnsZoneRow | null>;
  getByResource(resourceId: string): Promise<DnsZoneRow | null>;
  /**
   * The row of the purchase transaction. The resource is selected by id and customer in the same
   * statement as the insert: a resource of another customer, or a missing one, inserts nothing (R8).
   * A name that a live zone already holds violates the unique index (23505); the purchase handles it.
   */
  create(input: NewDnsZone): Promise<Written<{ id: string }>>;
}

const COLUMNS = {
  id: dnsZones.id,
  resourceId: dnsZones.resourceId,
  name: dnsZones.name,
  nameServers: dnsZones.nameServers,
  delegatedAt: dnsZones.delegatedAt,
  status: dnsZones.status,
  createdAt: dnsZones.createdAt,
};

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function dnsZonesRepo(scope: TenantScope): DnsZonesRepo {
  const { tx, customerId } = scope;
  return {
    list: async () =>
      tx
        .select(COLUMNS)
        .from(dnsZones)
        .where(eq(dnsZones.customerId, customerId))
        .orderBy(asc(dnsZones.name), asc(dnsZones.id)),

    get: async (id) => {
      if (!isUuid(id)) return null;
      const [row] = await tx
        .select(COLUMNS)
        .from(dnsZones)
        .where(and(eq(dnsZones.customerId, customerId), eq(dnsZones.id, id)));
      return row ?? null;
    },

    getByResource: async (resourceId) => {
      if (!isUuid(resourceId)) return null;
      const [row] = await tx
        .select(COLUMNS)
        .from(dnsZones)
        .where(and(eq(dnsZones.customerId, customerId), eq(dnsZones.resourceId, resourceId)));
      return row ?? null;
    },

    create: async (input) => {
      if (!isUuid(input.id)) throw new TypeError("dnsZones: id is not a UUID");
      if (!isUuid(input.resourceId)) return refused("not_found");
      if (
        typeof input.name !== "string" ||
        input.name.length > 253 ||
        !NAME.test(input.name) ||
        !(DNS_ZONE_STATUSES as readonly string[]).includes(input.status)
      ) {
        return refused("validation");
      }
      const inserted = await tx.execute(sql`
        insert into dns_zones (id, customer_id, resource_id, name, status)
        select ${input.id}, r.customer_id, r.id, ${input.name}, ${input.status}
        from resources r
        where r.id = ${input.resourceId} and r.customer_id = ${customerId}`);
      return inserted.rowCount === 1 ? created({ id: input.id }) : refused("not_found");
    },
  };
}
