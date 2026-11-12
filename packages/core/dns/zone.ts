import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";
import { validateZoneName } from "./records";

// WPU-G6: the DNS zone family as the order path sees it. A hosted zone lives in the tc-dns account: it
// has no pool account, no capacity cell and no catalog product. It is priced from the market's config
// price `config_price.dns_zone_month` (spec 08: the hosted zone has no price API), a 30-day product.
// The zone name is the only customer text that reaches Route 53, and only after validateZoneName
// accepted it; the AWS name of the resource and the comment of the zone are generated (R11).

export const DNS_ZONE_FLAG = "dns_zone";
/** Route 53 is global; tc-dns resources are recorded in the one Region of its Domains endpoint. */
export const DNS_ZONE_REGION = "us-east-1";
export const DNS_ZONE_TERM_DAYS = 30;
/** The `pid` of the signed draft and the item of the order: a zone has no product row. */
export const DNS_ZONE_PRODUCT = "dns_zone_month";

/** The words of `dns_zones.status` and of the status badge. */
export const DNS_ZONE_STATES = Object.freeze([
  "pending",
  "pending_delegation",
  "delegated",
  "removing",
  "removed",
  "failed",
] as const);
export type DnsZoneState = (typeof DNS_ZONE_STATES)[number];

export interface DnsZoneConfig {
  readonly zoneName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-written, like the other families. Only `zoneName` and `declaredControl` are read; every other
 * key is dropped, never copied (R11). A zone is allowed only for a domain the customer declares to
 * control (spec 12): the declaration is a boolean `true`, not a word.
 */
export function parseDnsZoneConfig(raw: unknown): Result<DnsZoneConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const name = validateZoneName(input["zoneName"]);
  if (!name.ok) fields["zoneName"] = "invalid_name";
  if (input["declaredControl"] !== true) fields["declaredControl"] = "required";
  if (Object.keys(fields).length > 0 || !name.ok) {
    return { ok: false, error: "validation", fields };
  }
  return { ok: true, value: { zoneName: name.value } };
}

export interface ResolvedDnsZone {
  readonly family: "dns_zone";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly quantity: string;
  readonly facts: ProductFacts;
  readonly needs: readonly never[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;

/**
 * Fails closed: a market with no zone price, or a price that is not a plain decimal, sells nothing
 * (R16). The price is text all the way to the pricing engine (R4).
 */
export function resolveDnsZone(
  config: DnsZoneConfig,
  price: { readonly usd: string } | undefined,
): Result<ResolvedDnsZone> {
  if (price === undefined || typeof price.usd !== "string" || !PRICE_TEXT.test(price.usd)) {
    return { ok: false, error: "validation", fields: { price: "unavailable" } };
  }
  return {
    ok: true,
    value: {
      family: "dns_zone",
      productId: DNS_ZONE_PRODUCT,
      region: DNS_ZONE_REGION,
      featureFlag: DNS_ZONE_FLAG,
      awsPriceUsd: price.usd,
      quantity: "1",
      // A zone is no server: the tier limits of bundle price and instances do not apply.
      facts: { bundleUsd: "0", windows: false, staticIps: 0 },
      needs: [],
      resourceConfig: {
        region: DNS_ZONE_REGION,
        displayName: config.zoneName,
        zoneName: config.zoneName,
        // The signed draft carries this config back to the purchase, which parses it again; the
        // declaration is kept on the resource as the record of what the customer said (spec 12).
        declaredControl: true,
      },
    },
  };
}

const isState = (value: unknown): value is DnsZoneState =>
  typeof value === "string" && (DNS_ZONE_STATES as readonly string[]).includes(value);

/**
 * The one word the screens show for a zone. The state of the resource decides first (a zone that is
 * still being created is pending whatever an older row says); the row only tells delegation. An
 * unknown word is "pending_delegation", the safe reading of an active zone (R16).
 */
export function zoneStatusWord(facts: {
  readonly resourceState: string;
  readonly rowStatus: string | null;
  readonly destroying?: boolean;
}): DnsZoneState {
  if (facts.resourceState === "creating") return "pending";
  if (facts.resourceState === "failed") return "failed";
  if (facts.resourceState === "destroyed") return "removed";
  if (facts.destroying === true) return "removing";
  return isState(facts.rowStatus) && facts.rowStatus === "delegated"
    ? "delegated"
    : "pending_delegation";
}
