import { eq } from "drizzle-orm";
import type { Tx } from "../client";
import { catalogProducts } from "../schema/index";

export interface CatalogProduct {
  readonly id: string;
  readonly family: string;
  readonly awsId: string;
  readonly platform: string | null;
  readonly region: string;
  readonly specs: unknown;
  /** numeric(12,4) as text, for example "3.5000". Never a number (R4). */
  readonly awsPriceUsd: string;
  readonly billingUnit: string;
  readonly featureFlag: string;
  readonly active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The columns are named, not selected with a star; `synced_at` and `created_at` are not read.
const columns = {
  id: catalogProducts.id,
  family: catalogProducts.family,
  awsId: catalogProducts.awsId,
  platform: catalogProducts.platform,
  region: catalogProducts.region,
  specs: catalogProducts.specs,
  awsPriceUsd: catalogProducts.awsPriceUsd,
  billingUnit: catalogProducts.billingUnit,
  featureFlag: catalogProducts.featureFlag,
  active: catalogProducts.active,
};

/**
 * One catalog row by id. The catalog is not a tenant table (no customer owns a row), so no customer
 * id is involved. Whether the product may be sold is the caller's decision (it checks `active`).
 * The message holds no input (R14).
 */
export async function readCatalogProduct(tx: Tx, id: string): Promise<CatalogProduct | null> {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new TypeError("readCatalogProduct: id is not a UUID");
  }
  const rows = await tx
    .select(columns)
    .from(catalogProducts)
    .where(eq(catalogProducts.id, id))
    .limit(1);
  return (rows[0] as CatalogProduct | undefined) ?? null;
}
