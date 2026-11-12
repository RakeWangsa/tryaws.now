import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";
import { normalizeDomainName } from "./name";
import { decideTld, type TldRow } from "./tld";

// WP7-T4: the domain family as the order path sees it. A domain is priced from the `tlds` row (the
// registration price per year), not from a catalog product, and it lives in the tc-dns account, so it
// takes no capacity and no pool account. The registrant contact reaches this file only as a sealed
// envelope (base64 of the KMS seal made by the action): the signed draft token never holds a name,
// an address or a phone number in the clear (R14).

/** Route 53 Domains answers in us-east-1 only (spec 12). */
export const DOMAIN_REGION = "us-east-1";
/** One year of registration is sold; the subscription term is the same year. */
export const DOMAIN_YEARS = 1;
export const DOMAIN_TERM_DAYS = 365;
export const DOMAIN_FLAG = "domain";

export interface DomainConfig {
  /** The id of the `tlds` row. */
  readonly productId: string;
  /** The ASCII name the customer confirmed. */
  readonly name: string;
  /** Base64 of the sealed contact envelope. */
  readonly contactSealed: string;
}

export interface ResolvedDomain {
  readonly family: "domain";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly quantity: string;
  readonly facts: ProductFacts;
  readonly needs: readonly never[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SEALED = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hand-written. Unknown keys, `awsName` and `capacityReservation` are dropped, never copied. */
export function parseDomainConfig(raw: unknown): Result<DomainConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const { productId, name, contactSealed } = input;
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof name !== "string" || name.length < 3 || name.length > 253) fields.name = "invalid";
  if (
    typeof contactSealed !== "string" ||
    contactSealed.length < 8 ||
    contactSealed.length > MAX_SEALED ||
    !BASE64.test(contactSealed)
  ) {
    fields.contactSealed = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      name: name as string,
      contactSealed: contactSealed as string,
    },
  };
}

/** The row of a TLD with the id the order path read it by. */
export interface TldProduct extends TldRow {
  readonly id: string;
}

function unavailable(): Result<never> {
  return { ok: false, error: "validation", fields: { productId: "unavailable" } };
}

/**
 * Fails closed: the row must be the one named, sold (a price for the registration and the renewal), and
 * the name must be one label in front of exactly that TLD. `review` TLDs are resolved too; the flag in
 * the resource config tells the purchase to queue the operation for approval.
 */
export function resolveDomain(config: DomainConfig, tld: TldProduct): Result<ResolvedDomain> {
  if (tld.id !== config.productId) return unavailable();
  const decision = decideTld(tld);
  if (decision === "unavailable" || tld.registrationPriceUsd === null) return unavailable();
  const normalized = normalizeDomainName(config.name, [tld.tld]);
  if (!normalized.ok || normalized.value.name !== config.name || normalized.value.tld !== tld.tld) {
    return { ok: false, error: "validation", fields: { name: "invalid" } };
  }
  return {
    ok: true,
    value: {
      family: "domain",
      productId: tld.id,
      region: DOMAIN_REGION,
      featureFlag: DOMAIN_FLAG,
      awsPriceUsd: tld.registrationPriceUsd,
      quantity: String(DOMAIN_YEARS),
      // A domain is no server: the tier limits of bundle price and instances do not apply.
      facts: { bundleUsd: "0", windows: false, staticIps: 0 },
      needs: [],
      resourceConfig: {
        productId: tld.id,
        region: DOMAIN_REGION,
        displayName: normalized.value.name,
        name: normalized.value.name,
        tld: tld.tld,
        years: DOMAIN_YEARS,
        review: decision === "review",
        contactSealed: config.contactSealed,
      },
    },
  };
}
