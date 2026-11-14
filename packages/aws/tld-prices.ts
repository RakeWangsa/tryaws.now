import { AwsError } from "./errors";

// WPU-X10: the TLD price parse and the price text rule, moved out of catalog.ts unchanged so that the Route 53
// Domains client (domains-client.ts) and the catalog source (catalog.ts) both use them without importing each
// other. catalog.ts re-exports every name, so the imports of before keep working.

export interface TldPrice {
  readonly tld: string;
  readonly registrationUsd: string | null;
  readonly renewalUsd: string | null;
  readonly transferUsd: string | null;
  readonly needsExtraParams: boolean;
}

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

/**
 * WPU-Z19: open point 4 is answered. No field of a `ListPrices` item marks a TLD that needs extra parameters or an
 * eligibility proof: DomainPrice holds only Name and five price objects (API_domains_DomainPrice, read 2026-11-14).
 * So the rule is a reviewed static allowlist. The TLDs here are not in the ExtraParam reference
 * (API_domains_ExtraParam: .au, .com.au, .net.au, .ca, .es, .eu, .fi, .it, .ru, .se, .sg, .uk, .co.uk, .me.uk,
 * .org.uk, and "many TLDs require a VAT_NUMBER") and their pages of "Domains that you can register with Amazon
 * Route 53" (com.html, net.html, org.html) list no registrant restriction. Every other TLD needs review: its order
 * waits for an admin (spec 12, R16). Adding a TLD here is a reviewed change of its own.
 */
export const NO_EXTRA_PARAMS_TLDS: ReadonlySet<string> = new Set(["com", "net", "org"]);

function needsExtraParams(tld: string): boolean {
  return !NO_EXTRA_PARAMS_TLDS.has(tld);
}

function usdPrice(value: unknown): string | null {
  if (!isRecord(value) || value.Currency !== "USD") return null; // another currency is never converted
  return priceText(value.Price);
}

/**
 * Pure: one page of a `ListPrices` answer to TLD prices. VERIFY the field names (`Prices`, `Name`,
 * `RegistrationPrice`, `RenewalPrice`, `TransferPrice`, `{ Price, Currency }`, `NextPageMarker`)
 * against the first real answer. WPU-X10: `tldPrices` of the catalog source now calls ListPrices through
 * `listPrices` of domains-client.ts (TcDnsReader), which parses every page here; the first staging sync is the
 * VERIFY of the field names.
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
      needsExtraParams: needsExtraParams(tld),
    });
  }
  const next = typeof page.NextPageMarker === "string" ? page.NextPageMarker : undefined;
  return { prices, next };
}
