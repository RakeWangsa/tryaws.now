import { domainNameHolder, readCatalogProduct, readTld, type CustomerRepos, type Tx } from "@tc/db";
import { parseDomainConfig, resolveDomain } from "../domains/resolve";
import type { RiskTier } from "../capacity/types";
import { isEnabledIn } from "../flags/is-enabled";
import { isFeatureFlag } from "../flags/keys";
import { checkCdnOrigin, parseCdnConfig, resolveCdn } from "../products/cdn";
import { checkDiskServer, parseDiskConfig, resolveDisk } from "../products/disk";
import { resolveProduct, type ResolvedProduct } from "../products/instance";
import { checkRestore, type RestoreCandidate } from "../products/restore";
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
  // A domain is no server: it takes no instance of the tier limit (WP7-T4).
  if (product.family === "domain") {
    return checkLimits(DEFAULT_TIER_LIMITS[customer.riskTier], { instances: 0 }, product.facts);
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

function candidateOf(
  row: {
    id: string;
    family: string;
    state: string;
    parentResourceId: string | null;
    region: string | null;
  } | null,
): RestoreCandidate | null {
  return row === null
    ? null
    : {
        id: row.id,
        family: row.family,
        state: row.state,
        parentResourceId: row.parentResourceId,
        region: row.region,
      };
}

function diskGbOf(specs: unknown): number {
  const value = (specs as { diskGb?: unknown } | null | undefined)?.diskGb;
  return typeof value === "number" ? value : Number.NaN;
}

/**
 * restoreToNewServer: the backup and the server it belongs to are read through the tenant-scoped
 * repository (another customer's row is `null`, like a missing one, R8), the disk sizes come from the
 * catalog rows of the two plans, and checkRestore decides. Used by the draft and again by the
 * purchase, inside the transaction; a read that fails throws and the action is refused (R16).
 */
async function checkRestoreSource(
  tx: Tx,
  repos: CustomerRepos,
  product: ResolvedProduct,
): Promise<Result<true>> {
  const requested = product.restoreFromBackupId ?? "";
  const backup = candidateOf(await repos.resources.get(requested));
  const sourceRow =
    backup?.parentResourceId == null ? null : await repos.resources.get(backup.parentResourceId);
  const sourceProduct =
    sourceRow?.productId == null ? null : await readCatalogProduct(tx, sourceRow.productId);
  const plan = await readCatalogProduct(tx, product.productId);
  const checked = checkRestore({
    requested,
    backup,
    source: candidateOf(sourceRow),
    sourceDiskGb: diskGbOf(sourceProduct?.specs),
    planDiskGb: diskGbOf(plan?.specs),
    planRegion: product.region,
  });
  return checked.ok ? { ok: true, value: true } : checked;
}

/**
 * The product of an order. Every family but the load balancer, the CDN and the disk is resolved by
 * `resolveProduct`. A disk names the server it is added for: the customer's own Linux server in the
 * Region of the disk (checkDiskServer). A distribution names an origin: the customer's own active server, load balancer
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
  if (family === "domain") {
    const config = parseDomainConfig(rawConfig);
    if (!config.ok) return config;
    // A TLD row, not a catalog product: web_rw reads `tlds` (WP7-T4).
    const tld = await readTld(tx, config.value.productId);
    if (tld === null) {
      return { ok: false, error: "validation", fields: { productId: "unavailable" } };
    }
    const resolved = resolveDomain(config.value, tld);
    if (!resolved.ok) return resolved;
    // One name is held once on the platform. A second order for a held name is a conflict, here for
    // the draft and again inside the purchase transaction; the provisioner re-checks it before
    // RegisterDomain (R16).
    if ((await domainNameHolder(tx, config.value.name)) !== null) {
      return { ok: false, error: "conflict", fields: { name: "taken" } };
    }
    return resolved;
  }
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
  if (family === "disk") {
    // addDisk: the anchor row of the Region and a server of the customer's own in that Region. The
    // server is read through the tenant-scoped repository, which answers `null` for another
    // customer's resource as for a missing one (R8); only the checked id reaches the config.
    const config = parseDiskConfig(rawConfig);
    if (!config.ok) return config;
    const anchor = await readCatalogProduct(tx, config.value.productId);
    if (anchor === null) {
      return { ok: false, error: "validation", fields: { productId: "unavailable" } };
    }
    const row = await repos.resources.get(config.value.serverId);
    const cfgRegion = (row?.config as { region?: unknown } | null | undefined)?.region;
    const checked = checkDiskServer({
      requested: config.value.serverId,
      region: config.value.region,
      server:
        row === null
          ? null
          : {
              id: row.id,
              family: row.family,
              state: row.state,
              region: row.region ?? (typeof cfgRegion === "string" ? cfgRegion : ""),
            },
    });
    if (!checked.ok) return checked;
    return resolveDisk(config.value, anchor);
  }
  if (family !== "load_balancer") {
    const resolved = await resolveProduct(family, rawConfig, (id) => readCatalogProduct(tx, id));
    if (!resolved.ok || resolved.value.restoreFromBackupId === undefined) return resolved;
    const restored = await checkRestoreSource(tx, repos, resolved.value);
    return restored.ok ? resolved : restored;
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
