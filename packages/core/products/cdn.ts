import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";

/** Distribution bundles of Lightsail CDN. VERIFY with GetDistributionBundles in staging. */
export const CDN_BUNDLES = Object.freeze(["small_1_0", "medium_1_0", "large_1_0"] as const);
export type CdnBundle = (typeof CDN_BUNDLES)[number];

/** The families that can be the origin of a distribution (10.3): own server, load balancer or bucket. */
export const CDN_ORIGIN_FAMILIES: readonly string[] = Object.freeze([
  "linux_instance",
  "windows_instance",
  "load_balancer",
  "bucket",
]);

export const CDN_CACHE_BEHAVIORS = Object.freeze(["cache", "dont-cache"] as const);
export type CdnCacheBehavior = (typeof CDN_CACHE_BEHAVIORS)[number];

export interface CdnConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
  /** Resource id of the customer's own origin. Checked by checkCdnOrigin before use. */
  readonly originId: string;
  readonly cacheBehavior: CdnCacheBehavior;
}

export interface ResolvedCdn {
  readonly family: "cdn";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly facts: ProductFacts;
  readonly needs: readonly CapacityNeed[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-written. The result holds five fields. A custom domain, a certificate name, `awsName` and every
 * unknown key are dropped, never copied (R11); custom domains are not part of this task.
 */
export function parseCdnConfig(raw: unknown): Result<CdnConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const { productId, region, displayName, originId, cacheBehavior } = input;
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (typeof originId !== "string" || !UUID.test(originId)) fields.originId = "invalid";
  if (
    cacheBehavior !== undefined &&
    !(CDN_CACHE_BEHAVIORS as readonly unknown[]).includes(cacheBehavior)
  ) {
    fields.cacheBehavior = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
      originId: originId as string,
      cacheBehavior: (cacheBehavior as CdnCacheBehavior | undefined) ?? "cache",
    },
  };
}

declare const checkedBrand: unique symbol;
/** An origin id that passed checkCdnOrigin. Only that function makes one (a branded type). */
export type CheckedOrigin = string & { readonly [checkedBrand]: true };

/** What the order path learns about the requested origin from the customer-scoped lookup. */
export interface OriginCandidate {
  readonly id: string;
  readonly customerId: string;
  readonly family: string;
  readonly state: string;
}

const ORIGIN_INVALID: Result<never> = Object.freeze({
  ok: false,
  error: "validation",
  fields: Object.freeze({ originId: "invalid" }),
}) as Result<never>;

/**
 * The rule of 10.3 and 16.10, pure (R8, R16). The origin must be one of the customer's own servers,
 * load balancers or buckets, active. A candidate of `null` is an origin that was not found for this
 * customer. Every failure is the same answer, so another customer's id cannot be told from a
 * missing one.
 */
export function checkCdnOrigin(input: {
  readonly customerId: string;
  readonly requested: string;
  readonly candidate: OriginCandidate | null;
}): Result<CheckedOrigin> {
  const { customerId, requested, candidate } = input;
  if (!UUID.test(requested) || candidate === null) return ORIGIN_INVALID;
  if (
    candidate.id !== requested ||
    candidate.customerId !== customerId ||
    !CDN_ORIGIN_FAMILIES.includes(candidate.family) ||
    candidate.state !== "active"
  ) {
    return ORIGIN_INVALID;
  }
  return { ok: true, value: requested as CheckedOrigin };
}

/** The bundle of a catalog product (its `aws_id`); null on any surprise (R16). */
export function cdnBundleFrom(awsId: unknown): CdnBundle | null {
  return typeof awsId === "string" && (CDN_BUNDLES as readonly string[]).includes(awsId)
    ? (awsId as CdnBundle)
    : null;
}

function unavailable(): Result<never> {
  return { ok: false, error: "validation", fields: { productId: "unavailable" } };
}

/**
 * A CDN row of the catalog (an admin-editable price row, 8). Fails closed. The origin of the result is
 * `checked`, never `config.originId`: the caller must have run checkCdnOrigin on a customer-scoped read
 * first (R8). resolveProduct does not know this family for that reason; the order path resolves it in
 * orders/checks.ts after the check.
 */
export function resolveCdn(
  config: CdnConfig,
  product: CatalogProduct,
  checked: CheckedOrigin,
): Result<ResolvedCdn> {
  if (
    product.id !== config.productId ||
    product.family !== "cdn" ||
    !product.active ||
    product.region !== config.region ||
    cdnBundleFrom(product.awsId) === null
  ) {
    return unavailable();
  }
  return {
    ok: true,
    value: {
      family: "cdn",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      facts: { bundleUsd: product.awsPriceUsd, windows: false, staticIps: 0 },
      needs: [{ quotaCode: "distribution", amount: 1 }],
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
        originId: checked,
        cacheBehavior: config.cacheBehavior,
      },
    },
  };
}
