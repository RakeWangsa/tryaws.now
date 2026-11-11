import { createDatabaseAdapter, type DatabaseDeps, type ProductAdapter } from "@tc/aws";
import { readCatalogProduct, withTx } from "@tc/db";

// Not in the catalog row: one blueprint for every managed database until the catalog carries it.
// VERIFY the id with GetRelationalDatabaseBlueprints in tc-pool-dev.
export const DEFAULT_DATABASE_BLUEPRINT_ID = "postgres_16";

// The production dependencies of the adapter. The bundle comes from the catalog row of the product
// in the order, read by id; a row that is not a database gives null and the create fails closed (R16).
export function databaseAdapter(): ProductAdapter<unknown> {
  const deps: DatabaseDeps = {
    loadLaunch: async ({ productId }) => {
      const product = await withTx((tx) => readCatalogProduct(tx, productId));
      return product === null || product.family !== "database"
        ? null
        : { bundleId: product.awsId, blueprintId: DEFAULT_DATABASE_BLUEPRINT_ID };
    },
  };
  return createDatabaseAdapter(deps) as ProductAdapter<unknown>;
}
