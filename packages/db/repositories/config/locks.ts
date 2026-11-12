import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { isMarketCode } from "./args";

// One lock per table and market, held to the end of the transaction: the second of two overlapping
// saves waits for the first to commit and then reads its row. RDS Proxy does not pin a connection
// on pg_advisory_xact_lock.
async function lock(tx: Tx, table: string, market: string): Promise<void> {
  if (!isMarketCode(market)) throw new TypeError("market: not a market code");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${table + ":" + market}, 0))`);
}

export function lockFxRateWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "fx_rates", market);
}

export function lockPricingRuleWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "pricing_rules", market);
}

export function lockPriceBookWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "price_book", market);
}

export function lockImageAllowListWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "image_allowlist", market);
}

export function lockConfigPriceWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "config_price", market);
}

export function lockInvoiceSellerWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "invoice_seller", market);
}

export function lockTierLimitsWrites(tx: Tx, market: string): Promise<void> {
  return lock(tx, "tier_limits", market);
}
