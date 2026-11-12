import { isPositiveDecimal } from "../pricing/index";

/**
 * One Lightsail bundle as the read-only AWS adapter hands it over (packages/aws never reaches this
 * package, so the shape is declared here). `priceUsd` is already decimal text: the adapter made it
 * from the float of `GetBundles`, or left "" when the float could not be proven plain (R4).
 */
export interface RawBundle {
  readonly bundleId: string;
  readonly name: string;
  readonly cpuCount: number;
  readonly ramSizeInGb: number;
  readonly diskSizeInGb: number;
  readonly transferPerMonthInGb: number;
  readonly priceUsd: string;
  readonly publicIpv4AddressCount: number;
  readonly supportedPlatforms: readonly string[];
  readonly isActive: boolean;
  readonly instanceType: string | null;
  readonly power: number | null;
}

export interface CatalogSpecs {
  vcpus: number;
  /** A size, not money. Text such as "0.5", so that a JSON number never needs rounding. */
  ramGb: string;
  diskGb: number;
  transferGb: number;
  publicIpv4: number;
  ipv6Only: boolean;
  name: string;
  instanceType: string | null;
  power: number | null;
}

export type InstanceFamily = "linux_instance" | "windows_instance";

export interface CatalogRowInput {
  readonly family: InstanceFamily;
  readonly awsId: string;
  readonly platform: "linux" | "windows";
  readonly region: string;
  readonly specs: CatalogSpecs;
  readonly awsPriceUsd: string;
  readonly billingUnit: "month";
  readonly featureFlag: InstanceFamily;
  readonly active: boolean;
}

export type MapRefusal = "bundle_id_invalid" | "price_invalid" | "cpu_invalid" | "platform_unknown";

export type MapResult =
  | { ok: true; rows: CatalogRowInput[]; skippedPlatforms: number }
  | { ok: false; reason: MapRefusal };

// R11: a catalog id later reaches the provisioner, so it must be shaped like an id.
const AWS_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
// R4: a string check, no arithmetic. At most 4 decimals, as numeric(12,4) holds.
const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;

const PLATFORMS: Readonly<
  Record<string, { family: InstanceFamily; platform: "linux" | "windows" }>
> = {
  LINUX_UNIX: { family: "linux_instance", platform: "linux" },
  WINDOWS: { family: "windows_instance", platform: "windows" },
};

const isPriceText = (v: unknown): v is string => typeof v === "string" && PRICE_TEXT.test(v);
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isCpu = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const safeCount = (v: unknown): number => (isCount(v) ? v : 0);

/**
 * The one rule that makes a plan `active` (open point 2). Every condition fails closed: AWS offers
 * it, it has an IPv4 address (an IPv6-only plan is never sold, spec 08), the price is a plain
 * decimal above zero with at most 4 decimals, and the CPU count is a positive integer. The feature
 * flag is not part of it: the flag decides sale, `active` decides whether the price is trusted.
 */
export function decideActive(raw: RawBundle): boolean {
  return (
    raw.isActive === true &&
    isCount(raw.publicIpv4AddressCount) &&
    raw.publicIpv4AddressCount >= 1 &&
    isPriceText(raw.priceUsd) &&
    isPositiveDecimal(raw.priceUsd) &&
    isCpu(raw.cpuCount)
  );
}

/**
 * One row per supported platform that the platform knows. A bundle whose id, price or CPU count
 * cannot be trusted is refused (not stored); a bundle that is merely not for sale is stored inactive.
 */
export function mapInstanceBundle(raw: RawBundle, region: string): MapResult {
  if (typeof raw.bundleId !== "string" || !AWS_ID.test(raw.bundleId)) {
    return { ok: false, reason: "bundle_id_invalid" };
  }
  if (!isPriceText(raw.priceUsd)) return { ok: false, reason: "price_invalid" };
  if (!isCpu(raw.cpuCount)) return { ok: false, reason: "cpu_invalid" };
  const platforms = Array.isArray(raw.supportedPlatforms) ? raw.supportedPlatforms : [];
  const distinct = [...new Set(platforms)];
  const known = distinct.filter((p) => Object.hasOwn(PLATFORMS, p));
  const skippedPlatforms = distinct.length - known.length;
  if (known.length === 0) return { ok: false, reason: "platform_unknown" };

  const active = decideActive(raw);
  const ramOk = typeof raw.ramSizeInGb === "number" && Number.isFinite(raw.ramSizeInGb);
  const specs: CatalogSpecs = {
    vcpus: raw.cpuCount,
    ramGb: ramOk && raw.ramSizeInGb >= 0 ? String(raw.ramSizeInGb) : "0",
    diskGb: safeCount(raw.diskSizeInGb),
    transferGb: safeCount(raw.transferPerMonthInGb),
    publicIpv4: safeCount(raw.publicIpv4AddressCount),
    ipv6Only: raw.publicIpv4AddressCount === 0,
    name: typeof raw.name === "string" ? raw.name : "",
    instanceType: typeof raw.instanceType === "string" ? raw.instanceType : null,
    power: isCount(raw.power) ? raw.power : null,
  };
  const rows = known.map((p): CatalogRowInput => {
    const target = PLATFORMS[p]!;
    return {
      family: target.family,
      awsId: raw.bundleId,
      platform: target.platform,
      region,
      specs: { ...specs },
      awsPriceUsd: raw.priceUsd,
      billingUnit: "month",
      featureFlag: target.family,
      active,
    };
  });
  return { ok: true, rows, skippedPlatforms };
}

export interface SyncPlan {
  readonly upserts: readonly CatalogRowInput[];
  readonly deactivate: readonly { family: string; awsId: string; region: string }[];
  readonly counts: {
    seen: number;
    mapped: number;
    refused: number;
    active: number;
    inactiveIpv6: number;
    deactivated: number;
  };
}

const keyOf = (family: string, awsId: string) => `${family}\u0000${awsId}`;

/**
 * Families whose catalog rows are seeded by a migration and belong to no AWS answer: the `disk`
 * anchor (migration 0008). The sync neither writes nor deactivates them, whatever scope it is given.
 */
export const PROTECTED_FAMILIES: readonly string[] = Object.freeze(["disk"]);
const synced = (family: string) => !PROTECTED_FAMILIES.includes(family);

/**
 * The plan of one scope (one Region): every mapped row is upserted; every existing active row of
 * the scope's families that the answer no longer carries (or carries refused) is deactivated.
 * Nothing is ever deleted. The plan is a pure function of its input, so a second plan built from
 * the first plan's rows has the same upserts and no deactivation (R7).
 */
export function planScopeSync(input: {
  region: string;
  families: readonly string[];
  bundles: readonly RawBundle[];
  existing: readonly { family: string; awsId: string; active: boolean }[];
}): SyncPlan {
  const upserts: CatalogRowInput[] = [];
  const mappedKeys = new Set<string>();
  let refused = 0;
  for (const bundle of input.bundles) {
    const mapped = mapInstanceBundle(bundle, input.region);
    if (!mapped.ok) {
      refused += 1;
      continue;
    }
    for (const row of mapped.rows) {
      if (!input.families.includes(row.family) || !synced(row.family)) continue;
      const key = keyOf(row.family, row.awsId);
      if (mappedKeys.has(key)) continue; // a repeated id in one answer: the first one wins
      mappedKeys.add(key);
      upserts.push(row);
    }
  }
  const deactivate = input.existing
    .filter((e) => e.active && input.families.includes(e.family) && synced(e.family))
    .filter((e) => !mappedKeys.has(keyOf(e.family, e.awsId)))
    .map((e) => ({ family: e.family, awsId: e.awsId, region: input.region }));
  return {
    upserts,
    deactivate,
    counts: {
      seen: input.bundles.length,
      mapped: upserts.length,
      refused,
      active: upserts.filter((r) => r.active).length,
      inactiveIpv6: upserts.filter((r) => r.specs.ipv6Only).length,
      deactivated: deactivate.length,
    },
  };
}

/**
 * R16: an empty answer while active rows exist, or a plan that would only deactivate, is not
 * applied. A bad AWS answer must not wipe the catalog.
 */
export function planIsSafe(plan: SyncPlan, existingActive: number): boolean {
  if (plan.counts.seen === 0 && existingActive > 0) return false;
  if (plan.deactivate.length > 0 && plan.upserts.length === 0) return false;
  return true;
}
