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

/**
 * The limits table, a constant table that is the configuration (WPU-R1). The owner relaxed the
 * count per resource family because the platform is an AWS partner: the mechanism stays, the
 * defaults are generous. `maxInstances` is the count of live resources per family (instance
 * families count together). The price, Windows and static IP limits are unchanged from 10.2.
 * WPU-G10: these are the DEFAULTS. An admin edits the limits of a tier for a market on /catalog/limits;
 * the order path reads that `settings` row (scope `tier`) through tierLimitsFromStored and falls back to
 * this table only when the market has no row.
 */
export const DEFAULT_TIER_LIMITS: Readonly<Record<RiskTier, TierLimits>> = {
  new: { maxInstances: 50, maxBundleUsd: "24", windows: false, containers: false, maxStaticIps: 1 },
  trusted: {
    maxInstances: 200,
    maxBundleUsd: "9999",
    windows: true,
    containers: false,
    maxStaticIps: 1,
  },
};

/**
 * The limits of one tier, read from `table`. R16: an unknown tier, a missing row or a count that
 * is not a positive whole number cannot be read, and the action is refused.
 */
export function tierLimitsOf(
  tier: string,
  table: Readonly<Record<string, TierLimits | undefined>> = DEFAULT_TIER_LIMITS,
): Result<TierLimits> {
  const row = Object.hasOwn(table, tier) ? table[tier] : undefined;
  if (row === undefined) return { ok: false, error: "forbidden" };
  if (!Number.isSafeInteger(row.maxInstances) || row.maxInstances < 1) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, value: row };
}

/** What `readTierLimits` of @tc/db answered for one tier of a market (WPU-G10). */
export type StoredTierLimits =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly limits: TierLimits };

/**
 * The limits of one tier of the customer's market: the row an admin saved (settings, scope `tier`), or
 * the defaults of the core when the market has no row. A row that is there and cannot be read refuses
 * (R16): the defaults are not a fallback for a broken row, so an edit gone wrong cannot widen a limit.
 */
export function tierLimitsFromStored(tier: string, stored: StoredTierLimits): Result<TierLimits> {
  if (!Object.hasOwn(DEFAULT_TIER_LIMITS, tier)) return { ok: false, error: "forbidden" };
  if (stored.state === "none") return tierLimitsOf(tier);
  if (stored.state === "invalid") return { ok: false, error: "forbidden" };
  return tierLimitsOf(tier, { [tier]: stored.limits });
}

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
