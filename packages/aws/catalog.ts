import {
  GetBlueprintsCommand,
  GetBundlesCommand,
  GetDistributionBundlesCommand,
  GetRelationalDatabaseBlueprintsCommand,
} from "@aws-sdk/client-lightsail";
import type { RawBlueprint, RawBundle, RawDbBlueprint, RawDistributionBundle } from "@tc/core";
import type { AwsAccess } from "./access";
import { AwsError } from "./errors";
import { createRoute53DomainsPort } from "./domains-client";
import type { AccountRef, LightsailRegion } from "./roles";
import { priceText, type TldPrice } from "./tld-prices";

export { NO_EXTRA_PARAMS_TLDS, parseTldPrices, priceText, type TldPrice } from "./tld-prices";

/**
 * The read-only catalog source (WP1-T5). It reads through the roles `TcReader` and `TcDnsReader`
 * only, and it hands the function plain values: the float `price` of `GetBundles` leaves this
 * file as decimal text or as the empty text, never as a number (R4, open point 13).
 *
 * Every fact about the real AWS answer is VERIFY in `tc-pool-dev` (open points 4, 12, 13).
 */
export interface CatalogSource {
  instanceBundles(account: AccountRef, region: LightsailRegion): Promise<readonly RawBundle[]>;
  /** WPU-G3: the images (blueprints) of one Region, inactive ones too. */
  instanceBlueprints(
    account: AccountRef,
    region: LightsailRegion,
  ): Promise<readonly RawBlueprint[]>;
  tldPrices(account: AccountRef): Promise<readonly TldPrice[]>;
  /**
   * WPU-B5: the CDN bundles. Distribution APIs exist in us-east-1 only, so the Region is fixed here
   * and the answer has no page token (API reference, GetDistributionBundles).
   */
  distributionBundles(account: AccountRef): Promise<readonly RawDistributionBundle[]>;
  /** WPU-B5: engine and version of the managed databases of one Region. */
  databaseBlueprints(
    account: AccountRef,
    region: LightsailRegion,
  ): Promise<readonly RawDbBlueprint[]>;
}

const DEFAULT_MAX_PAGES = 20;
// Distribution APIs are available in us-east-1 only (API reference, WPU-B5).
const CDN_REGION: LightsailRegion = "us-east-1";
const invalid = () =>
  new AwsError({ code: "internal", retryable: true, reason: "catalog_response_invalid" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

/** A field of the wrong type becomes NaN or "" so that the mapping refuses it; no default is guessed. */
function toRawBundle(item: unknown): RawBundle {
  if (!isRecord(item)) throw invalid();
  return {
    bundleId: typeof item.bundleId === "string" ? item.bundleId : "",
    name: typeof item.name === "string" ? item.name : "",
    cpuCount: num(item.cpuCount),
    ramSizeInGb: num(item.ramSizeInGb),
    diskSizeInGb: num(item.diskSizeInGb),
    transferPerMonthInGb: num(item.transferPerMonthInGb),
    priceUsd: priceText(item.price) ?? "",
    publicIpv4AddressCount: num(item.publicIpv4AddressCount),
    supportedPlatforms: Array.isArray(item.supportedPlatforms)
      ? item.supportedPlatforms.filter((p): p is string => typeof p === "string")
      : [],
    isActive: item.isActive === true,
    instanceType: typeof item.instanceType === "string" ? item.instanceType : null,
    power: typeof item.power === "number" ? item.power : null,
  };
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A field of the wrong type becomes null or false so that the mapping refuses it; no default is guessed. */
function toRawBlueprint(item: unknown): RawBlueprint {
  if (!isRecord(item)) throw invalid();
  return {
    blueprintId: typeof item.blueprintId === "string" ? item.blueprintId : "",
    name: typeof item.name === "string" ? item.name : "",
    type: text(item.type),
    group: text(item.group),
    version: text(item.version),
    platform: text(item.platform),
    isActive: item.isActive === true,
    // WPU-G10: the least bundle power the image runs on; anything but a number is "unknown" (null).
    minPower: typeof item.minPower === "number" ? item.minPower : null,
  };
}

function toRawDistributionBundle(item: unknown): RawDistributionBundle {
  if (!isRecord(item)) throw invalid();
  return {
    bundleId: typeof item.bundleId === "string" ? item.bundleId : "",
    name: typeof item.name === "string" ? item.name : "",
    priceUsd: priceText(item.price) ?? "",
    transferPerMonthInGb: num(item.transferPerMonthInGb),
    isActive: item.isActive === true,
  };
}

function toRawDbBlueprint(item: unknown): RawDbBlueprint {
  if (!isRecord(item)) throw invalid();
  return {
    blueprintId: typeof item.blueprintId === "string" ? item.blueprintId : "",
    engine: text(item.engine),
    engineVersion: text(item.engineVersion),
    engineDescription: text(item.engineDescription),
    engineVersionDescription: text(item.engineVersionDescription),
    isEngineDefault: item.isEngineDefault === true,
  };
}

export function createCatalogSource(
  access: AwsAccess<"catalog-sync">,
  opts: { maxPages?: number } = {},
): CatalogSource {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("createCatalogSource: maxPages must be a positive integer");
  }
  const source: CatalogSource = {
    async instanceBundles(account, region) {
      // The Region and the account are checked by `lightsail()` before any call is made.
      const client = access.lightsail(account, region, "TcReader");
      const out: RawBundle[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const response: unknown = await client.send(
          new GetBundlesCommand({
            includeInactive: true,
            ...(pageToken === undefined ? {} : { pageToken }),
          }),
        );
        if (!isRecord(response) || !Array.isArray(response.bundles)) throw invalid();
        for (const item of response.bundles) out.push(toRawBundle(item));
        const next = response.nextPageToken;
        if (next === undefined || next === null || next === "") return out;
        if (typeof next !== "string") throw invalid();
        pageToken = next;
      }
      // A token that never ends must not loop: the scope fails (R16).
      throw new AwsError({
        code: "internal",
        retryable: true,
        reason: "catalog_pages_exceeded",
        operation: "GetBundles",
      });
    },
    async instanceBlueprints(account, region) {
      const client = access.lightsail(account, region, "TcReader");
      const out: RawBlueprint[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const response: unknown = await client.send(
          new GetBlueprintsCommand({
            includeInactive: true,
            ...(pageToken === undefined ? {} : { pageToken }),
          }),
        );
        if (!isRecord(response) || !Array.isArray(response.blueprints)) throw invalid();
        for (const item of response.blueprints) out.push(toRawBlueprint(item));
        const next = response.nextPageToken;
        if (next === undefined || next === null || next === "") return out;
        if (typeof next !== "string") throw invalid();
        pageToken = next;
      }
      throw new AwsError({
        code: "internal",
        retryable: true,
        reason: "catalog_pages_exceeded",
        operation: "GetBlueprints",
      });
    },
    async distributionBundles(account) {
      const client = access.lightsail(account, CDN_REGION, "TcReader");
      const response: unknown = await client.send(new GetDistributionBundlesCommand({}));
      if (!isRecord(response) || !Array.isArray(response.bundles)) throw invalid();
      return response.bundles.map(toRawDistributionBundle);
    },
    async databaseBlueprints(account, region) {
      const client = access.lightsail(account, region, "TcReader");
      const out: RawDbBlueprint[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const response: unknown = await client.send(
          new GetRelationalDatabaseBlueprintsCommand(pageToken === undefined ? {} : { pageToken }),
        );
        if (!isRecord(response) || !Array.isArray(response.blueprints)) throw invalid();
        for (const item of response.blueprints) out.push(toRawDbBlueprint(item));
        const next = response.nextPageToken;
        if (next === undefined || next === null || next === "") return out;
        if (typeof next !== "string") throw invalid();
        pageToken = next;
      }
      throw new AwsError({
        code: "internal",
        retryable: true,
        reason: "catalog_pages_exceeded",
        operation: "GetRelationalDatabaseBlueprints",
      });
    },
    // WPU-X10: ListPrices of Route 53 Domains in the tc-dns account, read-only (TcDnsReader). The pages, the
    // parse and the page limit are those of `listPrices` (domains-client.ts); the account is checked by
    // `route53Domains()` before any call is made.
    async tldPrices(account) {
      return createRoute53DomainsPort(access.route53Domains(account, "TcDnsReader")).listPrices();
    },
  };
  return Object.freeze(source);
}
