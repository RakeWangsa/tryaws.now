import { readCatalogProduct, type CustomerRepos, type Tx } from "@tc/db";
import type { RiskTier } from "../capacity/types";
import { isEnabledIn } from "../flags/is-enabled";
import { isFeatureFlag } from "../flags/keys";
import { checkCdnOrigin, parseCdnConfig, resolveCdn } from "../products/cdn";
import { resolveProduct, type ResolvedProduct } from "../products/instance";
import {
  checkLbTargets,
  parseLoadBalancerConfig,
  resolveLoadBalancer,
  type TargetCandidate,
} from "../products/load-balancer";
import type { Result } from "../types";
import { checkCustomer, checkLimits, DEFAULT_TIER_LIMITS, type CustomerFacts } from "./gates";

const INSTANCE_FAMILIES = ["linux_instance", "windows_instance"] as const;

export interface Gated {
  readonly riskTier: RiskTier;
  readonly market: string;
}

/**
 * Reads the customer row of the scope and applies the customer gate. The session is never an input:
 * only the row decides (R16). A missing row is `forbidden`.
 */
export async function gateCustomer(
  repos: CustomerRepos,
  options?: { lock?: "share" },
): Promise<Result<Gated>> {
  const profile = await repos.profile.get(options);
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
  // Every instance family counts together toward the instance limit, so a customer at the Linux
  // limit cannot order Windows, nor the other way round. Same customer-scoped repository (R8).
  const families =
    product.family === "linux_instance" || product.family === "windows_instance"
      ? INSTANCE_FAMILIES
      : [product.family];
  let instances = 0;
  for (const family of families) instances += await repos.resources.countLive(family);
  return checkLimits(DEFAULT_TIER_LIMITS[customer.riskTier], { instances }, product.facts);
}

/**
 * The product of an order. Every family but the load balancer and the CDN is resolved by
 * `resolveProduct`. A distribution names an origin: the customer's own active server, load balancer
 * or bucket, read through the tenant-scoped repository, which answers `null` for another customer's
 * resource as for a missing one (R8); checkCdnOrigin decides and only the checked id reaches the
 * resource config. A load balancer names targets, and a target must be the scope customer's own active instance in the
 * Region of the load balancer: each id is read through the tenant-scoped repository, which answers
 * `null` for another customer's resource as for a missing one (R8), and checkLbTargets decides.
 * Only the ids that passed reach the resource config. Used by the draft and again by the purchase,
 * inside the transaction; a read that fails throws and the action is refused (R16).
 */
export async function resolveOrderProduct(
  tx: Tx,
  repos: CustomerRepos,
  customerId: string,
  family: string,
  rawConfig: unknown,
): Promise<Result<ResolvedProduct>> {
  if (family === "cdn") {
    const config = parseCdnConfig(rawConfig);
    if (!config.ok) return config;
    const product = await readCatalogProduct(tx, config.value.productId);
    if (product === null) {
      return { ok: false, error: "validation", fields: { productId: "unavailable" } };
    }
    const row = await repos.resources.get(config.value.originId);
    const checked = checkCdnOrigin({
      customerId,
      requested: config.value.originId,
      candidate:
        row === null ? null : { id: row.id, customerId, family: row.family, state: row.state },
    });
    if (!checked.ok) return checked;
    return resolveCdn(config.value, product, checked.value);
  }
  if (family !== "load_balancer") {
    return resolveProduct(family, rawConfig, (id) => readCatalogProduct(tx, id));
  }
  const config = parseLoadBalancerConfig(rawConfig);
  if (!config.ok) return config;
  const product = await readCatalogProduct(tx, config.value.productId);
  if (product === null) {
    return { ok: false, error: "validation", fields: { productId: "unavailable" } };
  }
  const requested = config.value.targetIds;
  const candidates: (TargetCandidate | null)[] = [];
  for (const id of requested) {
    const row = await repos.resources.get(id);
    const cfgRegion = (row?.config as { region?: unknown } | null | undefined)?.region;
    candidates.push(
      row === null
        ? null
        : {
            id: row.id,
            customerId,
            family: row.family,
            state: row.state,
            region: row.region ?? (typeof cfgRegion === "string" ? cfgRegion : ""),
          },
    );
  }
  const checked = checkLbTargets({
    customerId,
    region: config.value.region,
    requested,
    candidates,
  });
  if (!checked.ok) return checked;
  return resolveLoadBalancer(config.value, product, checked.value);
}
