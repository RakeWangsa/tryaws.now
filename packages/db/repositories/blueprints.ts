import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { catalogProducts } from "../schema/index";
import { readImageSwitches } from "./config/image-allowlist";

// WPU-G3. The images (Lightsail blueprints) of the Linux create wizard, as rows of `catalog_products`
// with the family `blueprint` (the sync writes them, one per Region) and the admin's switches
// (`image_allowlist` of `settings`). Not tenant data. Messages hold no input (R14).

export const BLUEPRINT_FAMILY = "blueprint";
const BLUEPRINT_ID = /^[a-z0-9_]{1,64}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** A synced image row of one Region; `specs` is what the sync wrote (parse it with optionOf of @tc/core). */
export interface ImageRow {
  readonly awsId: string;
  readonly region: string;
  readonly specs: unknown;
  readonly active: boolean;
}

const columns = {
  awsId: catalogProducts.awsId,
  region: catalogProducts.region,
  specs: catalogProducts.specs,
  active: catalogProducts.active,
};

/** The active images of one Region, by id. The caller applies the allow-list. */
export async function listActiveImages(tx: Tx, region: string): Promise<ImageRow[]> {
  if (typeof region !== "string" || !REGION.test(region)) {
    throw new TypeError("listActiveImages: region is invalid");
  }
  return tx
    .select(columns)
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.family, BLUEPRINT_FAMILY),
        eq(catalogProducts.region, region),
        eq(catalogProducts.active, true),
      ),
    )
    .orderBy(asc(catalogProducts.awsId));
}

/** One image of a Region whatever its switches (Connect help, provisioner), or null. */
export async function readImage(
  tx: Tx,
  region: string,
  blueprintId: string,
): Promise<ImageRow | null> {
  if (typeof blueprintId !== "string" || !BLUEPRINT_ID.test(blueprintId)) return null;
  if (typeof region !== "string" || !REGION.test(region)) return null;
  const rows = await tx
    .select(columns)
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.family, BLUEPRINT_FAMILY),
        eq(catalogProducts.region, region),
        eq(catalogProducts.awsId, blueprintId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** One image by id in any Region (the Connect help of a server whose Region row is gone), or null. */
export async function readImageAnyRegion(tx: Tx, blueprintId: string): Promise<ImageRow | null> {
  if (typeof blueprintId !== "string" || !BLUEPRINT_ID.test(blueprintId)) return null;
  const rows = await tx
    .select(columns)
    .from(catalogProducts)
    .where(
      and(eq(catalogProducts.family, BLUEPRINT_FAMILY), eq(catalogProducts.awsId, blueprintId)),
    )
    .orderBy(asc(catalogProducts.region))
    .limit(1);
  return rows[0] ?? null;
}

/** Every image row of every Region, inactive ones too, for the admin screen. */
export async function listImagesForAdmin(tx: Tx): Promise<ImageRow[]> {
  return tx
    .select(columns)
    .from(catalogProducts)
    .where(eq(catalogProducts.family, BLUEPRINT_FAMILY))
    .orderBy(asc(catalogProducts.awsId), asc(catalogProducts.region));
}

export { readImageSwitches };
