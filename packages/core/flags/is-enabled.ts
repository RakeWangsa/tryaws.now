import { readFeatureFlag, readFeatureFlags, withTx, type Tx } from "@tc/db";
import { FEATURE_FLAGS, isFeatureFlag, type FeatureFlag } from "./keys";

/**
 * True only when a row says true (R12). A key that is no flag, a missing row and an unknown market
 * are off. A database error is thrown, never answered as true (R16). Use this form inside a
 * transaction; WP4-T4 calls it in the purchase transaction.
 */
export async function isEnabledIn(tx: Tx, flag: FeatureFlag, market: string): Promise<boolean> {
  if (!isFeatureFlag(flag)) return false;
  return (await readFeatureFlag(tx, flag, market)) === true;
}

/**
 * Section F: `isEnabled(flag, market)`. It opens its own transaction, so it cannot run inside
 * `withTx`: use `isEnabledIn(tx, ...)` there (open point 9).
 */
export function isEnabled(flag: FeatureFlag, market: string): Promise<boolean> {
  return withTx((tx) => isEnabledIn(tx, flag, market));
}

export interface FlagState {
  key: FeatureFlag;
  enabled: boolean;
}

/** The twelve flags in the order of FEATURE_FLAGS, each with its state; a key with no row is off. */
export async function listFeatureFlags(tx: Tx, market: string): Promise<FlagState[]> {
  const on = new Set(
    (await readFeatureFlags(tx, market)).filter((f) => f.enabled).map((f) => f.key),
  );
  return FEATURE_FLAGS.map((key) => ({ key, enabled: on.has(key) }));
}
