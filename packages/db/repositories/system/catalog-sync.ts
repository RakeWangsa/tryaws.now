import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { catalogProducts, poolAccounts, tlds } from "../../schema/index";
import { requireInstant } from "../config/args";
import { isFeatureFlagKey } from "../config/feature-flags";

// The writes of the catalog-sync function (WP1-T5), as `worker_rw` may do them (migration 0006):
// INSERT of the data columns, UPDATE of platform, specs, aws_price_usd, billing_unit, active and
// synced_at on catalog_products, UPDATE of the price columns, needs_extra_params and synced_at on
// tlds, and no row-removal grant anywhere. A row is never removed: a plan that AWS no longer lists is
// deactivated. feature_flag and family are written on insert only. No function of this module takes
// a customer id: the catalog and the TLD list belong to nobody (tenancy.ts).
//
// The checks below are the same shapes as the mapping of packages/core (this package does not import
// it). Every message names the field, never the value (R14).

/** A catalog row as the function writes it. A structural copy of `CatalogRowInput` of @tc/core. */
export interface CatalogRowWrite {
  family: string;
  awsId: string;
  platform: string;
  region: string;
  specs: unknown;
  /** Plain decimal text with at most 4 decimals (R4). Never a number. */
  awsPriceUsd: string;
  billingUnit: string;
  featureFlag: string;
  active: boolean;
}

export interface CatalogKey {
  family: string;
  awsId: string;
  region: string;
}

export interface TldWrite {
  tld: string;
  registrationUsd: string | null;
  renewalUsd: string | null;
  transferUsd: string | null;
  needsExtraParams: boolean;
}

// R11: a catalog id later reaches the provisioner, so it must be shaped like an id.
const AWS_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;
const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const PLAIN_WORD = /^[a-z][a-z0-9_]{0,31}$/;
const TLD = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const ACCOUNT_ID = /^[0-9]{12}$/;

function bad(fn: string, field: string): never {
  throw new TypeError(`${fn}: ${field} is invalid`);
}

function checkKey(fn: string, key: CatalogKey): void {
  if (typeof key.family !== "string" || !FAMILY.test(key.family)) bad(fn, "family");
  if (typeof key.awsId !== "string" || !AWS_ID.test(key.awsId)) bad(fn, "awsId");
  if (typeof key.region !== "string" || !REGION.test(key.region)) bad(fn, "region");
}

function checkRow(row: CatalogRowWrite): void {
  const fn = "applyCatalogScope";
  checkKey(fn, row);
  if (typeof row.platform !== "string" || !PLAIN_WORD.test(row.platform)) bad(fn, "platform");
  if (typeof row.billingUnit !== "string" || !PLAIN_WORD.test(row.billingUnit)) {
    bad(fn, "billingUnit");
  }
  if (typeof row.awsPriceUsd !== "string" || !PRICE_TEXT.test(row.awsPriceUsd)) {
    bad(fn, "awsPriceUsd");
  }
  if (!isFeatureFlagKey(row.featureFlag)) bad(fn, "featureFlag");
  if (typeof row.active !== "boolean") bad(fn, "active");
  if (typeof row.specs !== "object" || row.specs === null || Array.isArray(row.specs)) {
    bad(fn, "specs");
  }
}

function checkTld(row: TldWrite): void {
  const fn = "applyTlds";
  if (typeof row.tld !== "string" || !TLD.test(row.tld)) bad(fn, "tld");
  for (const field of ["registrationUsd", "renewalUsd", "transferUsd"] as const) {
    const value = row[field];
    if (value !== null && (typeof value !== "string" || !PRICE_TEXT.test(value))) bad(fn, field);
  }
  if (typeof row.needsExtraParams !== "boolean") bad(fn, "needsExtraParams");
}

/** The keys of one Region and the given families, active or not: what the plan compares with. */
export async function listCatalogKeys(
  tx: Tx,
  scope: { region: string; families: readonly string[] },
): Promise<{ family: string; awsId: string; active: boolean }[]> {
  const fn = "listCatalogKeys";
  if (typeof scope.region !== "string" || !REGION.test(scope.region)) bad(fn, "region");
  if (!Array.isArray(scope.families) || scope.families.length === 0) bad(fn, "families");
  for (const family of scope.families) if (!FAMILY.test(family)) bad(fn, "families");
  return tx
    .select({
      family: catalogProducts.family,
      awsId: catalogProducts.awsId,
      active: catalogProducts.active,
    })
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.region, scope.region),
        inArray(catalogProducts.family, [...scope.families]),
      ),
    );
}

/**
 * Upserts the rows of one scope and deactivates the keys the plan names, in the caller's
 * transaction (R7: the unique key (family, aws_id, region) makes a second run change synced_at and
 * what AWS changed, nothing else). Inputs are checked before the first statement (R16). Returns
 * counts only. An existing order, subscription or price snapshot is never read or written.
 */
export async function applyCatalogScope(
  tx: Tx,
  input: { rows: readonly CatalogRowWrite[]; deactivate: readonly CatalogKey[]; at: Date },
): Promise<{ inserted: number; updated: number; deactivated: number }> {
  requireInstant(input.at, "applyCatalogScope");
  for (const row of input.rows) checkRow(row);
  for (const key of input.deactivate) checkKey("applyCatalogScope", key);

  let inserted = 0;
  let updated = 0;
  for (const row of input.rows) {
    // `xmax = 0` is true for a row this statement inserted and false for one it updated.
    const done = await tx
      .insert(catalogProducts)
      .values({
        family: row.family,
        awsId: row.awsId,
        platform: row.platform,
        region: row.region,
        specs: row.specs,
        awsPriceUsd: row.awsPriceUsd,
        billingUnit: row.billingUnit,
        featureFlag: row.featureFlag,
        active: row.active,
        syncedAt: input.at,
      })
      .onConflictDoUpdate({
        target: [catalogProducts.family, catalogProducts.awsId, catalogProducts.region],
        // Exactly the columns worker_rw may update. feature_flag and created_at stay as inserted.
        set: {
          platform: sql`excluded.platform`,
          specs: sql`excluded.specs`,
          awsPriceUsd: sql`excluded.aws_price_usd`,
          billingUnit: sql`excluded.billing_unit`,
          active: sql`excluded.active`,
          syncedAt: sql`excluded.synced_at`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (done[0]?.inserted === true) inserted += 1;
    else updated += 1;
  }

  let deactivated = 0;
  for (const key of input.deactivate) {
    const done = await tx
      .update(catalogProducts)
      .set({ active: false, syncedAt: input.at })
      .where(
        and(
          eq(catalogProducts.family, key.family),
          eq(catalogProducts.awsId, key.awsId),
          eq(catalogProducts.region, key.region),
          eq(catalogProducts.active, true),
        ),
      )
      .returning({ id: catalogProducts.id });
    deactivated += done.length;
  }
  return { inserted, updated, deactivated };
}

/**
 * Upserts TLD prices by tld. A TLD that a later answer lacks is not touched: `tlds` has no `active`
 * column and a missing TLD keeps its last price and its old synced_at (open point 5).
 */
export async function applyTlds(
  tx: Tx,
  input: { rows: readonly TldWrite[]; at: Date },
): Promise<{ inserted: number; updated: number }> {
  requireInstant(input.at, "applyTlds");
  for (const row of input.rows) checkTld(row);
  let inserted = 0;
  let updated = 0;
  for (const row of input.rows) {
    const done = await tx
      .insert(tlds)
      .values({
        tld: row.tld,
        registrationPriceUsd: row.registrationUsd,
        renewalPriceUsd: row.renewalUsd,
        transferPriceUsd: row.transferUsd,
        needsExtraParams: row.needsExtraParams,
        syncedAt: input.at,
      })
      .onConflictDoUpdate({
        target: tlds.tld,
        set: {
          registrationPriceUsd: sql`excluded.registration_price_usd`,
          renewalPriceUsd: sql`excluded.renewal_price_usd`,
          transferPriceUsd: sql`excluded.transfer_price_usd`,
          needsExtraParams: sql`excluded.needs_extra_params`,
          syncedAt: sql`excluded.synced_at`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (done[0]?.inserted === true) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}

/**
 * The account and ExternalId of an `active` pool account, by its AWS account id (the function has
 * no grant on pool_accounts.name, open point 6). Not active, not found or not a 12-digit id is
 * null, and the run fails closed (R16).
 */
export async function readPoolAccountRef(
  tx: Tx,
  awsAccountId: string,
): Promise<{ awsAccountId: string; externalId: string } | null> {
  if (typeof awsAccountId !== "string" || !ACCOUNT_ID.test(awsAccountId)) return null;
  const rows = await tx
    .select({ awsAccountId: poolAccounts.awsAccountId, externalId: poolAccounts.externalId })
    .from(poolAccounts)
    .where(and(eq(poolAccounts.awsAccountId, awsAccountId), eq(poolAccounts.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}
