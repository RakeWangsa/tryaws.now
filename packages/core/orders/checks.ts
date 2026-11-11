import type { CustomerRepos, Tx } from "@tc/db";
import type { RiskTier } from "../capacity/types";
import { isEnabledIn } from "../flags/is-enabled";
import { isFeatureFlag } from "../flags/keys";
import type { ResolvedProduct } from "../products/instance";
import type { Result } from "../types";
import { checkCustomer, checkLimits, DEFAULT_TIER_LIMITS, type CustomerFacts } from "./gates";

export interface Gated {
  readonly riskTier: RiskTier;
  readonly market: string;
}

/**
 * Reads the customer row of the scope and applies the customer gate. The session is never an input:
 * only the row decides (R16). A missing row is `forbidden`.
 */
export async function gateCustomer(repos: CustomerRepos): Promise<Result<Gated>> {
  const profile = await repos.profile.get();
  const facts: CustomerFacts | null =
    profile === null
      ? null
      : {
          status: profile.status,
          kycStatus: profile.kycStatus,
          riskTier: profile.riskTier,
          market: profile.market,
        };
  return checkCustomer(facts);
}

/**
 * A key pair named in the configuration must be a key of the scope's customer. The tenant-scoped
 * repository answers `null` for another customer's key as it does for a missing one, so both are
 * `keyPairId: invalid` and the refusal says nothing about whose key it is. A read that fails throws
 * and the action is refused (R16). Used by the draft and again by the purchase, before any write.
 */
export async function gateKeyPair(
  repos: CustomerRepos,
  product: ResolvedProduct,
): Promise<Result<true>> {
  const keyPairId = product.resourceConfig.keyPairId;
  if (keyPairId === undefined || keyPairId === null) return { ok: true, value: true };
  if (typeof keyPairId !== "string" || (await repos.sshKeys.get(keyPairId)) === null) {
    return { ok: false, error: "validation", fields: { keyPairId: "invalid" } };
  }
  return { ok: true, value: true };
}

/**
 * The feature flag of the product family (R12) and the risk-tier limits counted from the database.
 * A key that is no flag, a missing row and a flag that is off are all `flag_off`. Used by the draft
 * and again by the purchase: the state may have changed in between.
 */
export async function gateProduct(
  tx: Tx,
  repos: CustomerRepos,
  customer: Gated,
  product: ResolvedProduct,
): Promise<Result<true>> {
  if (!isFeatureFlag(product.featureFlag)) return { ok: false, error: "flag_off" };
  if (!(await isEnabledIn(tx, product.featureFlag, customer.market))) {
    return { ok: false, error: "flag_off" };
  }
  const instances = await repos.resources.countLive(product.family);
  return checkLimits(DEFAULT_TIER_LIMITS[customer.riskTier], { instances }, product.facts);
}
