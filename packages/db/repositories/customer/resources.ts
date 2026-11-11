import { and, desc, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { RESOURCE_STATES } from "../../schema/provisioning";
import { resources } from "../../schema/index";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// A resource of the customer, without the pool account and the AWS name (open point 13): the
// customer never sees which TiCON account holds a resource or what it is called inside AWS (R11).
// The state union is built from the list that resources_state_check is built from.
export interface ResourceSummary {
  id: string;
  family: string;
  productId: string | null;
  region: string | null;
  state: (typeof RESOURCE_STATES)[number];
  parentResourceId: string | null;
  config: unknown;
  createdAt: Date;
  deletedAt: Date | null;
}

// Reads only. The create of a resource is `orders.createResource`, because it belongs to the
// purchase transaction (WP4-T4).
export interface ResourcesRepo {
  list(): Promise<ResourceSummary[]>;
  get(id: string): Promise<ResourceSummary | null>;
  // The customer's resources of one family that count against a tier limit: every state but
  // destroyed and failed, and not soft-deleted.
  countLive(family: string): Promise<number>;
  // The customer's child resources of one family under a parent (the backups and the disks of a
  // server), newest first, destroyed ones left out. [] for a parent that is not the customer's.
  listChildren(parentId: string, family: string): Promise<ResourceSummary[]>;
  // The row of a manual backup of the customer's own server or disk (the web tier writes it, the
  // create_backup operation fills it in: WP5-T1). The pool and the Region come from the parent in the
  // same statement. `id` is the idempotency key (R7): a repeat answers with the stored row.
  // not_found for a parent that is not the customer's and for an id that belongs to anyone else.
  createBackupRow(input: {
    id: string;
    parentId: string;
    displayName: string;
  }): Promise<Written<ResourceSummary>>;
}

// Selected and returned by name: the repository never reads or returns a column it did not list.
const RESOURCE_COLUMNS = {
  id: resources.id,
  family: resources.family,
  productId: resources.productId,
  region: resources.region,
  state: resources.state,
  parentResourceId: resources.parentResourceId,
  config: resources.config,
  createdAt: resources.createdAt,
  deletedAt: resources.deletedAt,
};

// The parameter type makes the compiler check that the row holds all nine fields. The state column
// holds only the values of its CHECK, so narrowing it to the union with the cast is exact.
// The capacity reservation of the purchase names the pool account: it is internal and never leaves
// the repository (R11). The stored row keeps it; only the customer's copy is without it.
function withoutInternals(config: unknown): unknown {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  const { capacityReservation: _internal, ...rest } = config as Record<string, unknown>;
  return rest;
}
const toResource = (row: Record<keyof ResourceSummary, unknown>): ResourceSummary =>
  ({ ...row, config: withoutInternals(row.config) }) as unknown as ResourceSummary;

export function resourcesRepo(scope: TenantScope): ResourcesRepo {
  return {
    // Every state, destroyed and failed included, newest first.
    list: async () => {
      const rows = await scope.tx
        .select(RESOURCE_COLUMNS)
        .from(resources)
        .where(eq(resources.customerId, scope.customerId))
        .orderBy(desc(resources.createdAt), desc(resources.id));
      return rows.map(toResource);
    },

    // null for a missing row, a row of another customer and an id that is not a UUID alike (R8).
    get: async (id) => {
      if (!isUuid(id)) return null;
      const [row] = await scope.tx
        .select(RESOURCE_COLUMNS)
        .from(resources)
        .where(and(eq(resources.id, id), eq(resources.customerId, scope.customerId)));
      return row === undefined ? null : toResource(row);
    },

    listChildren: async (parentId, family) => {
      if (!isUuid(parentId)) return [];
      const rows = await scope.tx
        .select(RESOURCE_COLUMNS)
        .from(resources)
        .where(
          and(
            eq(resources.customerId, scope.customerId),
            eq(resources.parentResourceId, parentId),
            eq(resources.family, family),
            ne(resources.state, "destroyed"),
          ),
        )
        .orderBy(desc(resources.createdAt), desc(resources.id));
      return rows.map(toResource);
    },

    createBackupRow: async (input) => {
      if (!isUuid(input.id) || !isUuid(input.parentId)) return refused("not_found");
      if (
        typeof input.displayName !== "string" ||
        !/^[A-Za-z0-9 ._-]{1,60}$/.test(input.displayName)
      ) {
        return refused("validation");
      }
      const config = JSON.stringify({ displayName: input.displayName, manual: true });
      const inserted = await scope.tx.execute(sql`
        insert into resources (id, customer_id, family, pool_account_id, region, parent_resource_id, config)
        select ${input.id}, p.customer_id, 'backup', p.pool_account_id, p.region, p.id, ${config}::jsonb
        from resources p
        where p.id = ${input.parentId} and p.customer_id = ${scope.customerId}
          and p.family in ('linux_instance', 'disk') and p.deleted_at is null
        on conflict (id) do nothing`);
      const [row] = await scope.tx
        .select(RESOURCE_COLUMNS)
        .from(resources)
        .where(
          and(
            eq(resources.id, input.id),
            eq(resources.customerId, scope.customerId),
            eq(resources.parentResourceId, input.parentId),
            eq(resources.family, "backup"),
          ),
        );
      if (row === undefined) return refused("not_found");
      return (inserted.rowCount ?? 0) === 1 ? created(toResource(row)) : replayed(toResource(row));
    },

    // One statement that binds the customer id (R8). The count is a small integer, not money.
    countLive: async (family) => {
      const [row] = await scope.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(resources)
        .where(
          and(
            eq(resources.customerId, scope.customerId),
            eq(resources.family, family),
            notInArray(resources.state, ["destroyed", "failed"]),
            isNull(resources.deletedAt),
          ),
        );
      return row?.n ?? 0;
    },
  };
}
