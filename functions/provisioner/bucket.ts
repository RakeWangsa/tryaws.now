import { createBucketAdapter, type BucketDeps, type ProductAdapter } from "@tc/aws";
import { readCatalogProduct, withTx } from "@tc/db";

// The production dependencies of the bucket adapter: the catalog bundle id of a bucket product. The
// catalog is not a tenant table; a product of another family is no bundle (R16). VERIFY in staging
// that the synced bucket rows carry the GetBucketBundles id as aws_id.
export function bucketAdapter(): ProductAdapter<unknown> {
  const deps: BucketDeps = {
    loadBundle: async ({ productId }) => {
      const product = await withTx((tx) => readCatalogProduct(tx, productId));
      return product !== null && product.family === "bucket" ? product.awsId : null;
    },
  };
  return createBucketAdapter(deps) as ProductAdapter<unknown>;
}
