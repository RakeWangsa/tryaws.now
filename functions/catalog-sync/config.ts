import { LIGHTSAIL_REGIONS, type LightsailRegion } from "@tc/aws";

export interface CatalogSyncConfig {
  /** The 12-digit id of the pool account whose catalog is read (open point 6). Not a secret. */
  poolAccountId: string;
  dnsAccountId: string | null;
  /** A plain value, not a secret (06 6.3). */
  dnsExternalId: string | null;
  regions: LightsailRegion[];
  syncTlds: boolean;
}

const ACCOUNT_ID = /^[0-9]{12}$/;
const EXTERNAL_ID = /^[\w+=,.@:/-]{2,1224}$/;
const DEFAULT_REGIONS: readonly LightsailRegion[] = ["ap-southeast-1"];

// Fail closed (R16): the message names the variable and never its value (R3, R14).
// Only non-secret settings are read here; this function links no secret.
export function readConfig(env: Record<string, string | undefined>): CatalogSyncConfig {
  const bad = (name: string): Error => new Error(`catalog-sync: ${name} is missing or invalid`);

  const poolAccountId = env.CATALOG_POOL_ACCOUNT_ID;
  if (typeof poolAccountId !== "string" || !ACCOUNT_ID.test(poolAccountId)) {
    throw bad("CATALOG_POOL_ACCOUNT_ID");
  }

  let regions: LightsailRegion[] = [...DEFAULT_REGIONS];
  const rawRegions = env.CATALOG_REGIONS;
  if (rawRegions !== undefined) {
    const names = rawRegions.split(",").map((s) => s.trim());
    if (names.length === 0 || names.some((n) => n === "")) throw bad("CATALOG_REGIONS");
    const known = new Set<string>(LIGHTSAIL_REGIONS);
    // An unknown name is an error, not a silent drop; a repeated name would sync a scope twice.
    if (names.some((n) => !known.has(n)) || new Set(names).size !== names.length) {
      throw bad("CATALOG_REGIONS");
    }
    regions = names as LightsailRegion[];
  }

  const dnsAccountId = env.CATALOG_DNS_ACCOUNT_ID;
  const dnsExternalId = env.CATALOG_DNS_EXTERNAL_ID;
  if ((dnsAccountId === undefined) !== (dnsExternalId === undefined)) {
    throw bad(dnsAccountId === undefined ? "CATALOG_DNS_ACCOUNT_ID" : "CATALOG_DNS_EXTERNAL_ID");
  }
  if (dnsAccountId !== undefined && dnsExternalId !== undefined) {
    if (!ACCOUNT_ID.test(dnsAccountId)) throw bad("CATALOG_DNS_ACCOUNT_ID");
    if (!EXTERNAL_ID.test(dnsExternalId)) throw bad("CATALOG_DNS_EXTERNAL_ID");
    return { poolAccountId, dnsAccountId, dnsExternalId, regions, syncTlds: true };
  }
  return { poolAccountId, dnsAccountId: null, dnsExternalId: null, regions, syncTlds: false };
}
