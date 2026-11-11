import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { featureFlags } from "../../schema/index";
import { isFlagKeyText, isMarketCode } from "./args";

// One for each product family of section 10.3: the core four, then Gate A, then Gate B.
export const FEATURE_FLAG_KEYS = [
  "linux_instance",
  "static_ip",
  "backup",
  "disk",
  "windows_instance",
  "database",
  "load_balancer",
  "bucket",
  "container_service",
  "cdn",
  "dns_zone",
  "domain",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export function isFeatureFlagKey(key: unknown): key is FeatureFlagKey {
  return typeof key === "string" && (FEATURE_FLAG_KEYS as readonly string[]).includes(key);
}

// The stored value, or null when no row exists. A database error is thrown, never answered (R16).
export async function readFeatureFlag(
  tx: Tx,
  key: string,
  market: string,
): Promise<boolean | null> {
  if (!isFlagKeyText(key) || !isMarketCode(market)) return null;
  const rows = await tx
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(and(eq(featureFlags.key, key), eq(featureFlags.market, market)))
    .limit(1);
  return rows[0]?.enabled ?? null;
}

export async function readFeatureFlags(
  tx: Tx,
  market: string,
): Promise<{ key: string; enabled: boolean }[]> {
  if (!isMarketCode(market)) return [];
  return tx
    .select({ key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(eq(featureFlags.market, market))
    .orderBy(asc(featureFlags.key));
}
