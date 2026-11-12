import { and, asc, eq, sql } from "drizzle-orm";
import { domains } from "../../schema/index";
import { created, refused, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// A registered domain of the customer (WP7-T4). The customer id is not a field: the scope holds it (R8).
// Not selected, as web_rw has no grant on them: the Route 53 operation id, the hosted zone and the
// encrypted contact. The status words are `DOMAIN_STATES` of packages/core/domains.
export interface DomainRow {
  id: string;
  resourceId: string;
  name: string;
  tld: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface NewDomain {
  id: string;
  resourceId: string;
  name: string;
  tld: string;
  status: string;
  /** The sealed contact (KMS envelope). Never plain text (R14). */
  contactEncrypted: Uint8Array;
}

export interface DomainsRepo {
  list(): Promise<DomainRow[]>;
  getByName(name: string): Promise<DomainRow | null>;
  /**
   * The row of the purchase transaction. The resource is selected by id and customer in the same
   * statement as the insert: a resource of another customer, or a missing one, inserts nothing (R8).
   */
  create(input: NewDomain): Promise<Written<{ id: string }>>;
}

const COLUMNS = {
  id: domains.id,
  resourceId: domains.resourceId,
  name: domains.name,
  tld: domains.tld,
  status: domains.status,
  expiresAt: domains.expiresAt,
  createdAt: domains.createdAt,
};

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function domainsRepo(scope: TenantScope): DomainsRepo {
  const { tx, customerId } = scope;
  return {
    list: async () =>
      tx
        .select(COLUMNS)
        .from(domains)
        .where(eq(domains.customerId, customerId))
        .orderBy(asc(domains.name)),

    // null for a missing row, a row of another customer and a malformed name alike (R8).
    getByName: async (name) => {
      if (typeof name !== "string" || name.length > 253 || !NAME.test(name)) return null;
      const [row] = await tx
        .select(COLUMNS)
        .from(domains)
        .where(and(eq(domains.customerId, customerId), eq(domains.name, name)));
      return row ?? null;
    },

    create: async (input) => {
      if (!isUuid(input.id)) throw new TypeError("domains: id is not a UUID");
      if (!isUuid(input.resourceId)) return refused("not_found");
      if (
        !NAME.test(input.name) ||
        !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(input.tld) ||
        !/^[a-z_]{1,40}$/.test(input.status) ||
        input.contactEncrypted.length < 1
      ) {
        return refused("validation");
      }
      const inserted = await tx.execute(sql`
        insert into domains (id, customer_id, resource_id, name, tld, status,
                             registrant_contact_encrypted)
        select ${input.id}, r.customer_id, r.id, ${input.name}, ${input.tld}, ${input.status},
               ${Buffer.from(input.contactEncrypted)}
        from resources r
        where r.id = ${input.resourceId} and r.customer_id = ${customerId}`);
      return inserted.rowCount === 1 ? created({ id: input.id }) : refused("not_found");
    },
  };
}
