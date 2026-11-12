import { GetBlueprintsCommand, GetBundlesCommand } from "@aws-sdk/client-lightsail";
import type { RawBlueprint, RawBundle } from "@tc/core";
import type { AwsAccess } from "./access";
import { AwsError } from "./errors";
import type { AccountRef, LightsailRegion } from "./roles";

/**
 * The read-only catalog source (WP1-T5). It reads through the roles `TcReader` and `TcDnsReader`
 * only, and it hands the function plain values: the float `price` of `GetBundles` leaves this
 * file as decimal text or as the empty text, never as a number (R4, open point 13).
 *
 * Every fact about the real AWS answer is VERIFY in `tc-pool-dev` (open points 4, 12, 13).
 */
export interface TldPrice {
  readonly tld: string;
  readonly registrationUsd: string | null;
  readonly renewalUsd: string | null;
  readonly transferUsd: string | null;
  readonly needsExtraParams: boolean;
}

export interface CatalogSource {
  instanceBundles(account: AccountRef, region: LightsailRegion): Promise<readonly RawBundle[]>;
  /** WPU-G3: the images (blueprints) of one Region, inactive ones too. */
  instanceBlueprints(
    account: AccountRef,
    region: LightsailRegion,
  ): Promise<readonly RawBlueprint[]>;
  tldPrices(account: AccountRef): Promise<readonly TldPrice[]>;
}

const DEFAULT_MAX_PAGES = 20;
// A price that is plain decimal text with at most 4 decimals (numeric(12,4)). A string check:
// `String(n)` of a float artifact (0.30000000000000004) or of an exponent form fails it.
const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;
const TLD_TEXT = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * The one place a price leaves the float. Finite, not negative, and `String(n)` is plain decimal
 * text of at most 4 decimals; anything else is `null`. No `toFixed`, no rounding: AWS prices have
 * at most two decimals and print exactly.
 */
export function priceText(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const text = String(n);
  return PRICE_TEXT.test(text) ? text : null;
}

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

/**
 * VERIFY (open point 4): which field of a `ListPrices` item says that a TLD needs extra
 * parameters or an eligibility proof is not confirmed. Until it is, the conservative reading holds:
 * an item whose shape is not understood needs review (it goes to the admin step of spec 12), and
 * an item with a name and a registration price object does not. The fix is in this one function.
 */
function needsExtraParams(item: Record<string, unknown>): boolean {
  return typeof item.Name !== "string" || !isRecord(item.RegistrationPrice);
}

function usdPrice(value: unknown): string | null {
  if (!isRecord(value) || value.Currency !== "USD") return null; // another currency is never converted
  return priceText(value.Price);
}

/**
 * Pure: one page of a `ListPrices` answer to TLD prices. VERIFY the field names (`Prices`, `Name`,
 * `RegistrationPrice`, `RenewalPrice`, `TransferPrice`, `{ Price, Currency }`, `NextPageMarker`)
 * against the first real answer. TLD prices not proven: the Route 53 Domains client needs
 * `@aws-sdk/client-route-53-domains`, which could not be installed offline, so `tldPrices` of the
 * source is not configured yet and this parser is only tested against fake pages.
 */
export function parseTldPrices(page: unknown): {
  prices: TldPrice[];
  next: string | undefined;
} {
  if (!isRecord(page) || !Array.isArray(page.Prices)) throw invalid();
  const prices: TldPrice[] = [];
  for (const item of page.Prices) {
    if (!isRecord(item) || typeof item.Name !== "string") continue;
    const tld = item.Name.toLowerCase();
    if (!TLD_TEXT.test(tld)) continue; // the database check would refuse it: dropped here
    prices.push({
      tld,
      registrationUsd: usdPrice(item.RegistrationPrice),
      renewalUsd: usdPrice(item.RenewalPrice),
      transferUsd: usdPrice(item.TransferPrice),
      needsExtraParams: needsExtraParams(item),
    });
  }
  const next = typeof page.NextPageMarker === "string" ? page.NextPageMarker : undefined;
  return { prices, next };
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
    async tldPrices() {
      throw new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
    },
  };
  return Object.freeze(source);
}
