import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { catalogProducts, tlds } from "../schema/index";

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

/**
 * The active catalog rows of one family, cheapest first within a Region, for the configurator. Like
 * `readCatalogProduct` it is not tenant data. Whether the family may be sold in the customer's market
 * is the caller's decision (the feature flag).
 */
export async function listCatalogProducts(tx: Tx, family: string): Promise<CatalogProduct[]> {
  if (typeof family !== "string" || !/^[a-z][a-z_]{0,39}$/.test(family)) {
    throw new TypeError("listCatalogProducts: family is not a family name");
  }
  const rows = await tx
    .select(columns)
    .from(catalogProducts)
    .where(and(eq(catalogProducts.family, family), eq(catalogProducts.active, true)))
    .orderBy(
      asc(catalogProducts.region),
      asc(catalogProducts.awsPriceUsd),
      asc(catalogProducts.id),
    );
  return rows as CatalogProduct[];
}

/** A catalog row as the admin screen shows it: the customer columns and the time of the last sync. */
export interface CatalogAdminRow extends CatalogProduct {
  readonly syncedAt: Date;
}

/**
 * Every synced row, inactive ones too, for the admin catalog screen (16.12 /catalog), optionally of one
 * family. Read-only: admin_rw has SELECT on catalog_products and nothing else, the sync (worker_rw)
 * owns the AWS facts and `active`. Not tenant data. The message holds no input (R14).
 */
export async function listCatalogProductsForAdmin(
  tx: Tx,
  input: { family?: string },
): Promise<CatalogAdminRow[]> {
  const { family } = input;
  if (family !== undefined && (typeof family !== "string" || !/^[a-z][a-z_]{0,39}$/.test(family))) {
    throw new TypeError("listCatalogProductsForAdmin: family is not a family name");
  }
  const rows = await tx
    .select({ ...columns, syncedAt: catalogProducts.syncedAt })
    .from(catalogProducts)
    .where(family === undefined ? undefined : eq(catalogProducts.family, family))
    .orderBy(
      asc(catalogProducts.family),
      asc(catalogProducts.region),
      asc(catalogProducts.awsPriceUsd),
      asc(catalogProducts.id),
    );
  return rows as CatalogAdminRow[];
}

/** A row of `tlds` as the domain screens and the order path read it (WP7-T4). Prices are numeric text (R4). */
export interface TldRecord {
  readonly id: string;
  readonly tld: string;
  readonly registrationPriceUsd: string | null;
  readonly renewalPriceUsd: string | null;
  readonly needsExtraParams: boolean;
}

const TLD_COLUMNS = {
  id: tlds.id,
  tld: tlds.tld,
  registrationPriceUsd: tlds.registrationPriceUsd,
  renewalPriceUsd: tlds.renewalPriceUsd,
  needsExtraParams: tlds.needsExtraParams,
};

/**
 * One TLD row by id; `null` when there is none. Like the catalog it is not tenant data (web_rw has
 * SELECT on `tlds`). The message holds no input (R14).
 */
export async function readTld(tx: Tx, id: string): Promise<TldRecord | null> {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new TypeError("readTld: id is not a UUID");
  }
  const rows = await tx.select(TLD_COLUMNS).from(tlds).where(eq(tlds.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Every TLD row, by name. The caller decides what is sold (`decideTld` of packages/core/domains). */
export async function listTlds(tx: Tx): Promise<TldRecord[]> {
  return tx.select(TLD_COLUMNS).from(tlds).orderBy(asc(tlds.tld));
}
