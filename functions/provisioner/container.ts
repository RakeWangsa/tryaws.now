import { containerPlanFrom } from "@tc/core";
import {
  createContainerServiceAdapter,
  type ContainerServiceDeps,
  type ProductAdapter,
} from "@tc/aws";
import { readCatalogProduct, withTx } from "@tc/db";

// The production dependencies of the container service adapter: power from the catalog aws_id and
// scale from the specs of a container product (containerPlanFrom); anything else is no plan (R16).
// VERIFY in staging that the synced container rows have this shape (GetContainerServicePowers).
export function containerServiceAdapter(): ProductAdapter<unknown> {
  const deps: ContainerServiceDeps = {
    loadPlan: async ({ productId }) => {
      const product = await withTx((tx) => readCatalogProduct(tx, productId));
      if (product === null || product.family !== "container_service") return null;
      return containerPlanFrom(product.awsId, product.specs);
    },
  };
  return createContainerServiceAdapter(deps) as ProductAdapter<unknown>;
}
