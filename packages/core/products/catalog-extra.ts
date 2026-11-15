import { isPositiveDecimal } from "../pricing/index";

// WPU-B5 item 23. The two catalog halves that the instance sync did not cover: the Lightsail CDN bundles
// (GetDistributionBundles) and the engine and version of the managed databases
// (GetRelationalDatabaseBlueprints). Pure mappers, like catalog-sync.ts and blueprints.ts: the AWS adapter
// hands over plain values, the function writes the rows.

/** Distribution APIs of Lightsail exist in us-east-1 only (API reference, GetDistributionBundles). */
export const CDN_SYNC_REGION = "us-east-1";
export const CDN_FAMILY = "cdn";
/** The engine and version rows of the databases: one per blueprint and Region, never priced. */
export const DB_BLUEPRINT_FAMILY = "db_blueprint";

/** One `GetDistributionBundles` item; `priceUsd` is decimal text or "" (the float never leaves the adapter). */
export interface RawDistributionBundle {
  readonly bundleId: string;
  readonly name: string;
  readonly priceUsd: string;
  readonly transferPerMonthInGb: number;
  readonly isActive: boolean;
}

/** One `GetRelationalDatabaseBlueprints` item. A field of the wrong type is null or false. */
export interface RawDbBlueprint {
  readonly blueprintId: string;
  readonly engine: string | null;
  readonly engineVersion: string | null;
  readonly engineDescription: string | null;
  readonly engineVersionDescription: string | null;
  readonly isEngineDefault: boolean;
}

export interface CdnBundleRow {
  readonly family: typeof CDN_FAMILY;
  readonly awsId: string;
  readonly platform: "global";
  readonly region: typeof CDN_SYNC_REGION;
  readonly specs: { readonly name: string; readonly transferGb: number };
  readonly awsPriceUsd: string;
  readonly billingUnit: "month";
  readonly featureFlag: "cdn";
  readonly active: boolean;
}

export interface DbBlueprintRow {
  readonly family: typeof DB_BLUEPRINT_FAMILY;
  readonly awsId: string;
  readonly platform: "managed";
  readonly region: string;
  readonly specs: {
    readonly name: string;
    readonly engine: string;
    readonly version: string;
    readonly isDefault: boolean;
  };
  readonly awsPriceUsd: "0";
  readonly billingUnit: "none";
  readonly featureFlag: "database";
  readonly active: true;
}

// R11: a catalog id later reaches the provisioner, so it must be shaped like an id.
const AWS_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;
const ENGINE = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION = /^[0-9][0-9A-Za-z._-]{0,31}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, 80);
  return text === "" ? null : text;
}

/**
 * One CDN bundle to its catalog row, or null when the id, the price or the transfer cannot be trusted
 * (R16). A bundle AWS marks inactive is stored inactive. A price of zero is never active.
 */
export function mapDistributionBundle(raw: unknown): CdnBundleRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Partial<RawDistributionBundle>;
  if (typeof b.bundleId !== "string" || !AWS_ID.test(b.bundleId)) return null;
  if (typeof b.priceUsd !== "string" || !PRICE_TEXT.test(b.priceUsd)) return null;
  const transfer = b.transferPerMonthInGb;
  if (typeof transfer !== "number" || !Number.isSafeInteger(transfer) || transfer < 0) return null;
  return {
    family: CDN_FAMILY,
    awsId: b.bundleId,
    platform: "global",
    region: CDN_SYNC_REGION,
    specs: { name: cleanText(b.name) ?? b.bundleId, transferGb: transfer },
    awsPriceUsd: b.priceUsd,
    billingUnit: "month",
    featureFlag: "cdn",
    active: b.isActive === true && isPositiveDecimal(b.priceUsd),
  };
}

/**
 * One database blueprint of a Region to its catalog row, or null when the id, the engine or the
 * version is not a plain word (R16). AWS lists only blueprints it offers, so a listed one is active.
 */
export function mapDbBlueprint(raw: unknown, region: string): DbBlueprintRow | null {
  if (typeof region !== "string" || !REGION.test(region)) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Partial<RawDbBlueprint>;
  if (typeof b.blueprintId !== "string" || !AWS_ID.test(b.blueprintId)) return null;
  const engine = typeof b.engine === "string" ? b.engine.toLowerCase() : "";
  if (!ENGINE.test(engine)) return null;
  const version = typeof b.engineVersion === "string" ? b.engineVersion : "";
  if (!VERSION.test(version)) return null;
  return {
    family: DB_BLUEPRINT_FAMILY,
    awsId: b.blueprintId,
    platform: "managed",
    region,
    specs: {
      name:
        cleanText(b.engineVersionDescription) ?? cleanText(b.engineDescription) ?? b.blueprintId,
      engine,
      version,
      isDefault: b.isEngineDefault === true,
    },
    awsPriceUsd: "0",
    billingUnit: "none",
    featureFlag: "database",
    active: true,
  };
}

// WPU-X20. The container service plans: GetContainerServicePowers. Gate B found no plan on staging because no
// code wrote the family `container_service` (the sync covered servers, images, CDN and database engines only).

export const CONTAINER_FAMILY = "container_service";
/** The powers a container service can have (Lightsail), in the order of size. A power AWS adds later is refused until named here. */
const CONTAINER_POWER_IDS = ["nano", "micro", "small", "medium", "large", "xlarge"] as const;

/** One `GetContainerServicePowers` item (`name` "nano", `powerId` "nano-1"); `priceUsd` is decimal text or "" (the float never leaves the adapter). */
export interface RawContainerPower {
  readonly powerId: string;
  readonly name: string;
  readonly priceUsd: string;
  readonly cpuCount: number;
  readonly ramSizeInGb: number;
  readonly isActive: boolean;
}

/**
 * One row per power and Region (the unique key is family + aws_id + region), sold at scale 1 (one node):
 * `containerPlanFrom` reads the power from `aws_id` and the scale from `specs.scale`. The price is that of
 * one node; the customer cannot buy another scale at order time (JOURNEY WPU-G8, point B7).
 */
export interface ContainerPowerRow {
  readonly family: typeof CONTAINER_FAMILY;
  readonly awsId: string;
  readonly platform: "container";
  readonly region: string;
  readonly specs: {
    readonly name: string;
    readonly scale: 1;
    readonly vcpus: number;
    readonly ramGb: number;
  };
  readonly awsPriceUsd: string;
  readonly billingUnit: "month";
  readonly featureFlag: "container_service";
  readonly active: boolean;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * One container power of a Region to its catalog row, or null when the id, the Region, the price or the
 * size cannot be trusted (R16). Active only when AWS marks it active and the price is above zero.
 */
export function mapContainerPower(raw: unknown, region: string): ContainerPowerRow | null {
  if (typeof region !== "string" || !REGION.test(region)) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<RawContainerPower>;
  // The power of CreateContainerService is the NAME ("nano"); powerId is a longer id ("nano-1") (API reference,
  // ContainerServicePower). The name decides; the id's own prefix is the fallback when the name is missing.
  const nameKey = typeof p.name === "string" ? p.name.trim().toLowerCase() : "";
  const idKey = typeof p.powerId === "string" ? (p.powerId.split("-")[0] ?? "").toLowerCase() : "";
  const key = nameKey !== "" ? nameKey : idKey;
  if (!(CONTAINER_POWER_IDS as readonly string[]).includes(key)) return null;
  if (typeof p.priceUsd !== "string" || !PRICE_TEXT.test(p.priceUsd)) return null;
  const vcpus = positiveFinite(p.cpuCount);
  const ramGb = positiveFinite(p.ramSizeInGb);
  if (vcpus === null || ramGb === null) return null;
  return {
    family: CONTAINER_FAMILY,
    awsId: key,
    platform: "container",
    region,
    specs: { name: cleanText(p.name) ?? key, scale: 1, vcpus, ramGb },
    awsPriceUsd: p.priceUsd,
    billingUnit: "month",
    featureFlag: "container_service",
    active: p.isActive === true && isPositiveDecimal(p.priceUsd),
  };
}
