import { and, desc, eq } from "drizzle-orm";
import type { RESOURCE_STATES } from "../../schema/provisioning";
import { resources } from "../../schema/index";
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

// Reads only. The create of a resource belongs to the order flow (WP4-T4) and follows this pattern.
export interface ResourcesRepo {
  list(): Promise<ResourceSummary[]>;
  get(id: string): Promise<ResourceSummary | null>;
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
const toResource = (row: Record<keyof ResourceSummary, unknown>): ResourceSummary =>
  row as unknown as ResourceSummary;

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
  };
}
