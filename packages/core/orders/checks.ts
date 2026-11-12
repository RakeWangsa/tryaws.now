import {
  dnsZoneNameHolder,
  domainNameHolder,
  readCatalogProduct,
  readConfigPrices,
  readImage,
  readImageSwitches,
  readTierLimits,
  readTld,
  zoneNameDomainHold,
  type CustomerRepos,
  type Tx,
} from "@tc/db";
import { parseDnsZoneConfig, resolveDnsZone } from "../dns/zone";
import { parseDomainConfig, resolveDomain } from "../domains/resolve";
import type { RiskTier } from "../capacity/types";
import { isEnabledIn } from "../flags/is-enabled";
import { isFeatureFlag } from "../flags/keys";
import { checkCdnOrigin, parseCdnConfig, resolveCdn } from "../products/cdn";
import { checkDiskServer, parseDiskConfig, resolveDisk } from "../products/disk";
import { resolveProduct, type ResolvedProduct } from "../products/instance";
import {
  EMPTY_ALLOW_LIST,
  isImageOn,
  minPowerOf,
  optionOf,
  planFitsImage,
  type ImageAllowList,
} from "../products/blueprints";
import { checkRestore, type RestoreCandidate } from "../products/restore";
import {
  checkLbTargets,
  parseLoadBalancerConfig,
  resolveLoadBalancer,
  type TargetCandidate,
} from "../products/load-balancer";
import type { Result } from "../types";
import { checkCustomer, checkLimits, tierLimitsFromStored, type CustomerFacts } from "./gates";

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
 * WPU-G3. The image a customer chose for a new Linux server must be listed active by AWS in the Region of
 * the plan and switched on in the admin allow-list of the market; a stored allow-list that does not
 * parse offers nothing (R16). An order without an image (an older order, a restore) is not checked
 * here: the provisioner then uses the default image, and a restored server keeps the image of its
 * backup. The Server Action of the create wizard requires the image and the SSH key (G6) before the
 * draft is made. Used by the draft and again by the purchase: the admin may have switched the image off
 * in between. Windows has its own flow.
 */
export async function gateImage(
  tx: Tx,
  customer: Gated,
  product: ResolvedProduct,
): Promise<Result<true>> {
  const id = product.resourceConfig.blueprintId;
  if (product.family !== "linux_instance" || id === undefined) return { ok: true, value: true };
  const invalid: Result<true> = {
    ok: false,
    error: "validation",
    fields: { blueprintId: "invalid" },
  };
  if (typeof id !== "string") return invalid;
  const stored = await readImageSwitches(tx, customer.market);
  if (stored.state === "invalid") return invalid;
  const row = await readImage(tx, product.region, id);
  const option = row === null || !row.active ? null : optionOf(row);
  const switches: ImageAllowList = stored.state === "ok" ? stored.switches : EMPTY_ALLOW_LIST;
  if (option === null || !isImageOn(switches, id)) return invalid;
  // WPU-G10. Lightsail refuses an app on a bundle below its minimum power, so the plan must reach the
  // minimum of the image (the admin's override, else what AWS reported, else the default of the core).
  // A plan whose power is unknown does not fit an image that has a minimum (R16). Checked again by the
  // purchase, so a raised minimum between the draft and the purchase stops the sale before any write.
  const plan = await readCatalogProduct(tx, product.productId);
  const power = (plan?.specs as { power?: unknown } | null | undefined)?.power;
  const planPower =
    typeof power === "number" && Number.isSafeInteger(power) && power >= 0 ? power : null;
  if (!planFitsImage(minPowerOf(option, switches), planPower)) {
    return { ok: false, error: "validation", fields: { productId: "plan_too_small" } };
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
  // WPU-G10: the limits of the tier are the market's settings row, or the defaults when it has none.
  const limits = tierLimitsFromStored(
    customer.riskTier,
    await readTierLimits(tx, customer.market, customer.riskTier),
  );
  if (!limits.ok) return limits;
  // A domain and a DNS zone are no server: they take no instance of the tier limit (WP7-T4, WPU-G6).
  if (product.family === "domain" || product.family === "dns_zone") {
    return checkLimits(limits.value, { instances: 0 }, product.facts);
  }
  // Every instance family counts together toward the instance limit, so a customer at the Linux
  // limit cannot order Windows, nor the other way round. Same customer-scoped repository (R8).
  const families =
    product.family === "linux_instance" || product.family === "windows_instance"
      ? INSTANCE_FAMILIES
      : [product.family];
  let instances = 0;
  for (const family of families) instances += await repos.resources.countLive(family);
  return checkLimits(limits.value, { instances }, product.facts);
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
  at: Date = new Date(),
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
  if (family === "dns_zone") {
    const config = parseDnsZoneConfig(rawConfig);
    if (!config.ok) return config;
    // The zone is priced from the market's config price: the market is the customer's own row (R16).
    const profile = await repos.profile.get();
    if (profile === null) return { ok: false, error: "forbidden" };
    // The price in force at the instant of the order (WPU-G10: an admin may schedule a change).
    const price = (await readConfigPrices(tx, profile.market, at))["config_price.dns_zone_month"];
    const resolved = resolveDnsZone(config.value, price);
    if (!resolved.ok) return resolved;
    // WPU-S1. A domain of ANOTHER customer that is the name or a parent of it (checked by whole labels)
    // refuses the order with the generic "taken", which does not say whose it is (R8). The customer's own
    // domain as the name: its hosted zone in tc-dns is adopted, not created (spec 12); adoption is not
    // built, so the order is refused (R16). A subdomain of the customer's own domain is allowed.
    const domainHold = await zoneNameDomainHold(tx, config.value.zoneName, customerId);
    if (domainHold === "other") {
      return { ok: false, error: "conflict", fields: { zoneName: "taken" } };
    }
    if (domainHold === "own") {
      return { ok: false, error: "validation", fields: { zoneName: "registered_here" } };
    }
    // Only a zone that is already DELEGATED is exclusive. A pending zone is harmless until the NS records
    // point at it (Route 53 allows several zones for one name), so several customers may hold one. Here
    // for the draft and again inside the purchase transaction; the unique index of migration 0012 is the
    // last word.
    if ((await dnsZoneNameHolder(tx, config.value.zoneName)) !== null) {
      return { ok: false, error: "conflict", fields: { zoneName: "taken" } };
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
