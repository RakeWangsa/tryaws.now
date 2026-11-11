import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../client";
import { isMarketCode, requireInstant } from "../repositories/config/args";
import { settings } from "../schema/index";

// Prices that have no API (spec 08 "Catalog sync sources"): block storage per GB, snapshot per GB,
// load balancer, hosted zone. They live in `settings` as rows `config_price.<name>` with
// scope 'market' and the value { usd, unit } (open point 7). The seed is run as the table owner
// (no application role but admin_rw may write `settings`); later edits are the admin editor's.
// The launch values are the owner's, from the AWS pricing pages: the seed takes them as input.

export const CONFIG_PRICE_KEYS = [
  "config_price.block_storage_gb_month",
  "config_price.snapshot_gb_month",
  "config_price.load_balancer_month",
  "config_price.dns_zone_month",
] as const;
export type ConfigPriceKey = (typeof CONFIG_PRICE_KEYS)[number];

const UNIT_OF: Readonly<Record<ConfigPriceKey, "gb_month" | "month">> = Object.freeze({
  "config_price.block_storage_gb_month": "gb_month",
  "config_price.snapshot_gb_month": "gb_month",
  "config_price.load_balancer_month": "month",
  "config_price.dns_zone_month": "month",
});

export interface ConfigPriceInput {
  key: ConfigPriceKey;
  usd: string;
  unit: "gb_month" | "month";
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
const isUnit = (v: unknown): v is "gb_month" | "month" => v === "gb_month" || v === "month";
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
    if (typeof price.usd !== "string" || !PRICE_TEXT.test(price.usd)) bad("usd");
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

/**
 * The config prices of a market. A value that is not { usd: plain decimal, unit: known } is
 * undefined: a bad row is not a price (R16). Only scope 'market' rows are read, so no customer
 * setting is reachable from here.
 */
export async function readConfigPrices(
  tx: Tx,
  market: string,
): Promise<Record<ConfigPriceKey, { usd: string; unit: string } | undefined>> {
  if (!isMarketCode(market)) throw new TypeError("readConfigPrices: market is invalid");
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.market, market),
        eq(settings.scope, "market"),
        inArray(settings.key, [...CONFIG_PRICE_KEYS]),
      ),
    );
  const out: Record<ConfigPriceKey, { usd: string; unit: string } | undefined> = {
    "config_price.block_storage_gb_month": undefined,
    "config_price.snapshot_gb_month": undefined,
    "config_price.load_balancer_month": undefined,
    "config_price.dns_zone_month": undefined,
  };
  for (const row of rows) {
    if (!isKey(row.key)) continue;
    const v = row.value;
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const { usd, unit } = v as Record<string, unknown>;
    if (typeof usd === "string" && PRICE_TEXT.test(usd) && isUnit(unit)) {
      out[row.key] = { usd, unit };
    }
  }
  return out;
}
