import type { Tx } from "@tc/db";
import { quoteWithBook, type PriceQuote } from "../pricing/index";
import { pricingInForce, type PricingInForce } from "../rates/in-force";
import type { Clock, Result } from "../types";

/** The columns of a catalog row that pricing needs: a structural copy of `CatalogProduct` of @tc/db. */
export interface CatalogRowForPricing {
  readonly id: string;
  readonly family: string;
  readonly awsId: string;
  readonly platform: string | null;
  readonly region: string;
  readonly specs: unknown;
  /** numeric(12,4) as text, for example "3.5000". Never a number (R4). */
  readonly awsPriceUsd: string;
  readonly billingUnit: string;
  readonly featureFlag: string;
  readonly active: boolean;
}

export interface PricedCatalogRow {
  readonly id: string;
  readonly family: string;
  readonly region: string;
  readonly platform: string | null;
  readonly specs: unknown;
  readonly awsPriceUsd: string;
  /** The BDT price of the row at the instant of the call. Computed, never stored (open point 8). */
  readonly priceBdt: PriceQuote;
  /** The margin inside that price and the reseller's share of it, in paisa (the price book, WPA-P1). */
  readonly marginMinor: bigint;
  readonly commissionMinor: bigint;
}

/**
 * Prices rows with rates that were read already (one per family). The only arithmetic is the
 * engine's `quote`. Returns null when a row's family has no rate and rule in force: nothing is
 * priced then (R16). Inactive rows are left out unless the caller asks for them.
 */
export function priceRows(
  rows: readonly CatalogRowForPricing[],
  byFamily: ReadonlyMap<string, PricingInForce>,
  options: { includeInactive?: boolean },
): PricedCatalogRow[] | null {
  const out: PricedCatalogRow[] = [];
  for (const row of rows) {
    if (!row.active && options.includeInactive !== true) continue;
    const found = byFamily.get(row.family);
    if (found === undefined) return null;
    const booked = quoteWithBook(
      { awsPriceUsd: row.awsPriceUsd, fxRate: found.fx.rate, rule: found.rule.value },
      found.book,
    );
    out.push({
      id: row.id,
      family: row.family,
      region: row.region,
      platform: row.platform,
      specs: row.specs,
      awsPriceUsd: row.awsPriceUsd,
      priceBdt: booked.quote,
      marginMinor: booked.marginMinor,
      commissionMinor: booked.commissionMinor,
    });
  }
  return out;
}

/**
 * The customer catalog in BDT. The rate and the rule are read once per distinct family, at one
 * instant for the whole call (the clock is read once). No rate or no rule for a family, or a row
 * the engine refuses, and no row is priced (R16).
 */
export async function priceCatalog(
  tx: Tx,
  rows: readonly CatalogRowForPricing[],
  input: { market: string; includeInactive?: boolean },
  clock: Clock,
): Promise<Result<readonly PricedCatalogRow[]>> {
  const instant = clock.now();
  const once: Clock = { now: () => instant };
  const wanted = rows.filter((r) => r.active || input.includeInactive === true);
  const families = [...new Set(wanted.map((r) => r.family))];
  const byFamily = new Map<string, PricingInForce>();
  for (const family of families) {
    const found = await pricingInForce(tx, { market: input.market, productFamily: family }, once);
    if (!found.ok) return found;
    byFamily.set(family, found.value);
  }
  try {
    const priced = priceRows(
      rows,
      byFamily,
      input.includeInactive === true ? { includeInactive: true } : {},
    );
    if (priced === null) return { ok: false, error: "not_found" };
    return { ok: true, value: priced };
  } catch {
    // the engine refused a stored value: fixed answer, no value in it (R14, R16)
    return { ok: false, error: "internal", fields: { price: "refused" } };
  }
}
