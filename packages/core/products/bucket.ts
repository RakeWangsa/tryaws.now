import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";

/**
 * WPU-S6. How many instances a bucket remembers as granted (config.accessInstances). Suspend revokes
 * from that list, so an allow past the cap is refused before AWS is asked, never cut off afterwards.
 */
export const MAX_ACCESS_INSTANCES = 20;

export interface BucketConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
}

/** What UpdateBucket takes as `accessRules`. Objects may never override to public (R16). */
export interface BucketAccess {
  readonly getObject: "private" | "public";
  readonly allowPublicOverrides: false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hand-written like parseInstanceConfig: collects every invalid field, drops unknown keys. */
export function parseBucketConfig(raw: unknown): Result<BucketConfig> {
  const input = isRecord(raw) ? raw : {};
  const { productId, region, displayName } = input;
  const fields: Record<string, string> = {};
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
    },
  };
}

/** The payload of `set_bucket_access`: input from the web tier. null when it is anything else. */
export function parseBucketAccess(raw: unknown): BucketAccess | null {
  if (!isRecord(raw)) return null;
  const { mode } = raw;
  if (mode !== "private" && mode !== "public") return null;
  return { getObject: mode, allowPublicOverrides: false };
}

export interface ResolvedBucket {
  readonly family: "bucket";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly facts: ProductFacts;
  readonly needs: readonly CapacityNeed[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

/**
 * A bucket row of the catalog (its `aws_id` is the Lightsail bundle id, read again by the adapter).
 * Fails closed (R16). The config holds three fields and no access setting: a new bucket is private
 * and the adapter sets it so (R11, R12).
 */
export function resolveBucket(
  config: BucketConfig,
  product: CatalogProduct,
): Result<ResolvedBucket> {
  if (
    product.id !== config.productId ||
    product.family !== "bucket" ||
    !product.active ||
    product.region !== config.region
  ) {
    return { ok: false, error: "validation", fields: { productId: "unavailable" } };
  }
  return {
    ok: true,
    value: {
      family: "bucket",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      facts: { bundleUsd: product.awsPriceUsd, windows: false, staticIps: 0 },
      needs: [{ quotaCode: "bucket", amount: 1 }],
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
      },
    },
  };
}
