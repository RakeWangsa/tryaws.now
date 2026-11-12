import { isPositiveDecimal } from "../pricing/index";
import type { Result } from "../types";
import type { ResolvedProduct } from "./instance";

// WPA-P2. Where a family has a catalog row AND an editable config price (block storage per GB-month,
// load balancer per month; the hosted zone has no catalog row and the snapshot is not an order), the
// config row prices NEW orders when the market has a usable one. Without a row the catalog row stays
// authoritative. The price stays decimal text up to the pricing engine, which turns it into paisa with
// the FX rate in force and the half-up rule (R4); nothing here is arithmetic.

/**
 * `row` is the config price of the market in force at the instant of the order, or undefined when the
 * market has none (never saved, not started yet, or a stored value that does not parse: a bad row is
 * not a price, see `readConfigPrices`). A row that exists but cannot be a price (zero, wrong unit, not a
 * plain decimal) sells nothing: a free product by accident is the worse failure (R16).
 */
export function withConfigPrice<T extends ResolvedProduct>(
  resolved: T,
  row: { readonly usd: string; readonly unit: string } | undefined,
  unit: "gb_month" | "month",
): Result<T> {
  if (row === undefined) return { ok: true, value: resolved };
  if (row.unit !== unit || !isPositiveDecimal(row.usd)) {
    return { ok: false, error: "validation", fields: { price: "unavailable" } };
  }
  return {
    ok: true,
    value: {
      ...resolved,
      awsPriceUsd: row.usd,
      facts: { ...resolved.facts, bundleUsd: row.usd },
    },
  };
}
