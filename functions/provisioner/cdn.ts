import { cdnBundleFrom } from "@tc/core";
import { createCdnAdapter, type CdnDeps, type ProductAdapter } from "@tc/aws";
import { lifecycleRepo, readCatalogProduct, withTx } from "@tc/db";

// The production dependencies of the CDN adapter: the bundle comes from the catalog aws_id of a
// product of the family `cdn` (cdnBundleFrom); anything else is no bundle (R16). The origin is read
// by the runner through ctx.owned, which answers only for the customer of the operation (R8).
// VERIFY in staging that the synced CDN rows carry the distribution bundle id as aws_id.
export function cdnAdapter(): ProductAdapter<unknown> {
  const deps: CdnDeps = {
    loadBundle: async ({ productId }) => {
      const product = await withTx((tx) => readCatalogProduct(tx, productId));
      if (product === null || product.family !== "cdn") return null;
      return cdnBundleFrom(product.awsId);
    },
    // WPU-S7: the apply runs only for the period it was queued for; the database says which it is.
    periodEndOf: (input) => withTx((tx) => lifecycleRepo(tx).periodEndOf(input)),
  };
  return createCdnAdapter(deps) as ProductAdapter<unknown>;
}
