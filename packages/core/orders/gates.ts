import type { RiskTier } from "../capacity/types";
import { decimalAtMost } from "../pricing/index";
import type { Result } from "../types";

/** The customer row as read under the wallet lock. The session's copy is never an input (R16). */
export interface CustomerFacts {
  readonly status: string;
  readonly kycStatus: string;
  readonly riskTier: string;
  readonly market: string;
}

const TIERS: readonly string[] = ["new", "trusted"];

function isRiskTier(text: string): text is RiskTier {
  return TIERS.includes(text);
}

/**
 * No row, a status other than `active` and an unknown tier are `forbidden`; any KYC value but the
 * exact text `verified` is `kyc_required`. Fails closed on text it does not know.
 */
export function checkCustomer(
  facts: CustomerFacts | null,
): Result<{ riskTier: RiskTier; market: string }> {
  if (facts === null) return { ok: false, error: "forbidden" };
  if (facts.status !== "active") return { ok: false, error: "forbidden" };
  if (facts.kycStatus !== "verified") return { ok: false, error: "kyc_required" };
  if (!isRiskTier(facts.riskTier)) return { ok: false, error: "forbidden" };
  return { ok: true, value: { riskTier: facts.riskTier, market: facts.market } };
}

export interface TierLimits {
  readonly maxInstances: number;
  readonly maxBundleUsd: string;
  readonly windows: boolean;
  readonly containers: boolean;
  readonly maxStaticIps: number;
}

/** The documented defaults of 10.2 (open point 10); WP8-T3 makes them admin-editable. */
export const DEFAULT_TIER_LIMITS: Readonly<Record<RiskTier, TierLimits>> = {
  new: { maxInstances: 2, maxBundleUsd: "24", windows: false, containers: false, maxStaticIps: 1 },
  trusted: {
    maxInstances: 20,
    maxBundleUsd: "9999",
    windows: true,
    containers: false,
    maxStaticIps: 1,
  },
};

export interface ProductFacts {
  readonly bundleUsd: string;
  readonly windows: boolean;
  readonly staticIps: number;
}

function limited(limit: "instances" | "bundle_price" | "windows" | "static_ips"): Result<true> {
  return { ok: false, error: "limit_reached", fields: { limit } };
}

/**
 * `live.instances` is the count of the customer's live instances from the database. Throws
 * RangeError for a bundle price that is not plain decimal text (fail closed, nothing is guessed).
 */
export function checkLimits(
  limits: TierLimits,
  live: { readonly instances: number },
  product: ProductFacts,
): Result<true> {
  if (live.instances >= limits.maxInstances) return limited("instances");
  if (!decimalAtMost(product.bundleUsd, limits.maxBundleUsd)) return limited("bundle_price");
  if (product.windows && !limits.windows) return limited("windows");
  if (product.staticIps > limits.maxStaticIps) return limited("static_ips");
  return { ok: true, value: true };
}
