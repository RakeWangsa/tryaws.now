import type { Tx } from "../client";
import { isMarketCode, requireInstant } from "../repositories/config/args";
import { settings } from "../schema/index";
import {
  CONFIG_PRICE_KEYS,
  CONFIG_PRICE_UNIT_OF,
  readConfigPrices,
  type ConfigPriceKey,
} from "../repositories/config/config-price";

// Prices that have no API (spec 08 "Catalog sync sources"): block storage per GB, snapshot per GB,
// load balancer, hosted zone. They live in `settings` as rows `config_price.<name>` with
// scope 'market' and the value { usd, unit } (open point 7). The seed is run as the table owner
// (no application role but admin_rw may write `settings`); later edits are the admin editor's.
// The launch values are the owner's, from the AWS pricing pages: the seed takes them as input.

export { CONFIG_PRICE_KEYS, readConfigPrices, type ConfigPriceKey };
const UNIT_OF = CONFIG_PRICE_UNIT_OF;

export interface ConfigPriceInput {
  key: ConfigPriceKey;
  usd: string;
  unit: "gb_month" | "month" | "hour";
}

/**
 * The built default for staging (open point 7): the two values the repo already uses as data in
 * PREVIEW_SAMPLES, a disk at 0.10 per GB-month and a backup at 0.05. The load balancer and the
 * hosted zone are left absent so that their BDT price answers not_found instead of a guess (R16).
 * VERIFY against the AWS pricing pages before any production seed.
 */
export const STAGING_CONFIG_PRICES: readonly ConfigPriceInput[] = Object.freeze([
  { key: "config_price.block_storage_gb_month", usd: "0.10", unit: "gb_month" },
  { key: "config_price.snapshot_gb_month", usd: "0.05", unit: "gb_month" },
]);

const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;
const isKey = (v: unknown): v is ConfigPriceKey =>
  typeof v === "string" && (CONFIG_PRICE_KEYS as readonly string[]).includes(v);
const isUnit = (v: unknown): v is "gb_month" | "month" | "hour" =>
  v === "gb_month" || v === "month" || v === "hour";
const bad = (field: string): never => {
  throw new TypeError(`seedConfigPrices: ${field} is invalid`);
};

/**
 * Inserts the prices that are missing, changes nothing that exists (a value an admin edited stays).
 * Inputs are checked before the first statement. Returns the keys it added.
 */
export async function seedConfigPrices(
  tx: Tx,
  input: { market: string; at: Date; prices: readonly ConfigPriceInput[] },
): Promise<{ added: string[] }> {
  requireInstant(input.at, "seedConfigPrices");
  if (!isMarketCode(input.market)) bad("market");
  for (const price of input.prices) {
    if (!isKey(price.key)) bad("key");
    // A price of zero is no price (WPU-M2, R16): it needs a digit from 1 to 9.
    if (typeof price.usd !== "string" || !PRICE_TEXT.test(price.usd) || !/[1-9]/.test(price.usd)) {
      bad("usd");
    }
    if (!isUnit(price.unit) || price.unit !== UNIT_OF[price.key]) bad("unit");
  }
  const added: string[] = [];
  for (const price of input.prices) {
    const done = await tx
      .insert(settings)
      .values({
        key: price.key,
        market: input.market,
        scope: "market",
        scopeId: null,
        value: { usd: price.usd, unit: price.unit },
        setBy: null,
        createdAt: input.at,
      })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (done.length > 0) added.push(price.key);
  }
  return { added };
}
