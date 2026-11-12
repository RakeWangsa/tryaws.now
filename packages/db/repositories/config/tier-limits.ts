import { and, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isMarketCode } from "./args";

// The limits of a risk tier (WPU-G10): how many resources a customer of the tier may hold, the dearest
// bundle, and whether Windows and containers are open. One row of `settings` for each tier and market:
// key `tier_limits`, scope 'tier', scope id = the tier name, and the value
//
//   { "v": 1, "maxInstances": 50, "maxBundleUsd": "24", "windows": false, "containers": false,
//     "maxStaticIps": 1 }
//
// No row means the defaults of @tc/core (DEFAULT_TIER_LIMITS). A row that does not parse is `invalid`
// and the order path refuses (R16). Written only by adminRepos.tierLimits.save (audited); read by the
// order code (web_rw, worker_rw), which already have SELECT on these columns of `settings`. The shape
// check is a copy of what @tc/core needs; @tc/db cannot import the core.

export const TIER_LIMITS_KEY = "tier_limits";
export const TIER_LIMITS_VERSION = 1;
export const RISK_TIERS = ["new", "trusted"] as const;
export type RiskTierName = (typeof RISK_TIERS)[number];
/** An upper bound that no honest limit reaches; it keeps a typing error from becoming "unlimited". */
export const TIER_LIMIT_MAX_COUNT = 100000;

export interface TierLimitsValue {
  readonly maxInstances: number;
  readonly maxBundleUsd: string;
  readonly windows: boolean;
  readonly containers: boolean;
  readonly maxStaticIps: number;
}

const BUNDLE_USD = /^(0|[1-9]\d{0,5})(\.\d{1,4})?$/;
const KEYS = new Set([
  "v",
  "maxInstances",
  "maxBundleUsd",
  "windows",
  "containers",
  "maxStaticIps",
]);

export const isRiskTierName = (v: unknown): v is RiskTierName =>
  typeof v === "string" && (RISK_TIERS as readonly string[]).includes(v);

const whole = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= TIER_LIMIT_MAX_COUNT;

/** The limits as stored (without `v`), or null when anything in it is wrong: a bad row is not a limit (R16). */
export function parseTierLimitsValue(value: unknown): TierLimitsValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== TIER_LIMITS_VERSION) return null;
  if (Object.keys(v).some((k) => !KEYS.has(k))) return null;
  if (!whole(v.maxInstances, 1) || !whole(v.maxStaticIps, 0)) return null;
  if (typeof v.maxBundleUsd !== "string" || !BUNDLE_USD.test(v.maxBundleUsd)) return null;
  if (!/[1-9]/.test(v.maxBundleUsd)) return null;
  if (typeof v.windows !== "boolean" || typeof v.containers !== "boolean") return null;
  return {
    maxInstances: v.maxInstances,
    maxBundleUsd: v.maxBundleUsd,
    windows: v.windows,
    containers: v.containers,
    maxStaticIps: v.maxStaticIps,
  };
}

export function tierLimitsValueOf(limits: TierLimitsValue): unknown {
  return {
    v: TIER_LIMITS_VERSION,
    maxInstances: limits.maxInstances,
    maxBundleUsd: limits.maxBundleUsd,
    windows: limits.windows,
    containers: limits.containers,
    maxStaticIps: limits.maxStaticIps,
  };
}

export type TierLimitsRead =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly limits: TierLimitsValue };

/**
 * The stored limits of one tier of a market. `invalid` is a row that does not parse: the caller
 * refuses instead of guessing (R16). Not tenant data. Messages hold no input (R14).
 */
export async function readTierLimits(
  tx: Tx,
  market: string,
  tier: string,
): Promise<TierLimitsRead> {
  if (!isMarketCode(market)) throw new TypeError("readTierLimits: market is invalid");
  if (!isRiskTierName(tier)) throw new TypeError("readTierLimits: tier is invalid");
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, TIER_LIMITS_KEY),
        eq(settings.market, market),
        eq(settings.scope, "tier"),
        eq(settings.scopeId, tier),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { state: "none" };
  const limits = parseTierLimitsValue(row.value);
  return limits === null ? { state: "invalid" } : { state: "ok", limits };
}
