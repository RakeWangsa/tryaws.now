import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isMarketCode } from "./args";

// The config prices (spec 08 "Catalog sync sources", WPU-G10): the prices that have no AWS API (block
// storage per GB, snapshot per GB, load balancer, hosted zone). One row of `settings` for each key
// `config_price.<name>`, scope 'market'. Two stored shapes are read:
//
//   legacy (the seed):  { "usd": "18", "unit": "month" }                      one price, always in force
//   dated (an admin):   { "v": 1, "unit": "month",
//                         "entries": [ { "from": "<ISO instant>", "usd": "18", "by": "<admin id>" | null } ] }
//
// The entries are ascending by `from`. The entry in force is the last one that has started; a later one
// is a scheduled change. A save appends (adminRepos.configPrices.save, audited with before and after); a
// legacy row becomes the first entry, from the epoch. A price applies to the orders priced after its
// start; an order already placed keeps its stored snapshot. Both shapes are read with web_rw and
// worker_rw, which already have SELECT on these columns of `settings`.

export const CONFIG_PRICE_KEYS = [
  "config_price.block_storage_gb_month",
  "config_price.snapshot_gb_month",
  "config_price.load_balancer_month",
  "config_price.dns_zone_month",
] as const;
export type ConfigPriceKey = (typeof CONFIG_PRICE_KEYS)[number];
export type ConfigPriceUnit = "gb_month" | "month";

export const CONFIG_PRICE_UNIT_OF: Readonly<Record<ConfigPriceKey, ConfigPriceUnit>> =
  Object.freeze({
    "config_price.block_storage_gb_month": "gb_month",
    "config_price.snapshot_gb_month": "gb_month",
    "config_price.load_balancer_month": "month",
    "config_price.dns_zone_month": "month",
  });

export const CONFIG_PRICE_VERSION = 1;
/** The longest history one price keeps; older entries stay in the audit log. */
export const CONFIG_PRICE_MAX_ENTRIES = 50;
/** USD per unit as plain decimal text, at most 4 decimals (numeric(12,4) elsewhere). */
export const CONFIG_PRICE_TEXT = /^\d{1,8}(\.\d{1,4})?$/;
const LEGACY_TEXT = /^\d+(\.\d{1,4})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH = new Date(0);

export interface ConfigPriceEntry {
  readonly from: Date;
  readonly usd: string;
  readonly by: string | null;
}

export interface ConfigPriceRow {
  readonly key: ConfigPriceKey;
  readonly unit: ConfigPriceUnit;
  /** Ascending by start. */
  readonly entries: readonly ConfigPriceEntry[];
}

export const isConfigPriceKey = (v: unknown): v is ConfigPriceKey =>
  typeof v === "string" && (CONFIG_PRICE_KEYS as readonly string[]).includes(v);
const isUnit = (v: unknown): v is ConfigPriceUnit => v === "gb_month" || v === "month";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The entries of a stored value (either shape), or null when anything is wrong: a bad row is not a price (R16). */
export function parseConfigPriceValue(
  key: ConfigPriceKey,
  value: unknown,
): ConfigPriceEntry[] | null {
  if (!isObject(value)) return null;
  const unit = CONFIG_PRICE_UNIT_OF[key];
  if (value.v === undefined) {
    if (typeof value.usd !== "string" || !LEGACY_TEXT.test(value.usd) || value.unit !== unit) {
      return null;
    }
    return [{ from: EPOCH, usd: value.usd, by: null }];
  }
  if (value.v !== CONFIG_PRICE_VERSION || value.unit !== unit || !Array.isArray(value.entries)) {
    return null;
  }
  if (value.entries.length === 0 || value.entries.length > CONFIG_PRICE_MAX_ENTRIES) return null;
  const out: ConfigPriceEntry[] = [];
  for (const raw of value.entries as unknown[]) {
    if (!isObject(raw) || typeof raw.from !== "string" || typeof raw.usd !== "string") return null;
    const from = new Date(raw.from);
    if (Number.isNaN(from.getTime()) || from.toISOString() !== raw.from) return null;
    if (!LEGACY_TEXT.test(raw.usd)) return null;
    const by =
      raw.by === null ? null : typeof raw.by === "string" && UUID.test(raw.by) ? raw.by : "";
    if (by === "") return null;
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.from.getTime() >= from.getTime()) return null;
    out.push({ from, usd: raw.usd, by });
  }
  return out;
}

export function configPriceValueOf(
  key: ConfigPriceKey,
  entries: readonly ConfigPriceEntry[],
): unknown {
  return {
    v: CONFIG_PRICE_VERSION,
    unit: CONFIG_PRICE_UNIT_OF[key],
    entries: entries.map((e) => ({ from: e.from.toISOString(), usd: e.usd, by: e.by })),
  };
}

/** The entry in force at an instant: the last one that has started, or null. */
export function entryOfConfigPriceAt(
  entries: readonly ConfigPriceEntry[],
  at: Date,
): ConfigPriceEntry | null {
  let found: ConfigPriceEntry | null = null;
  for (const entry of entries) if (entry.from.getTime() <= at.getTime()) found = entry;
  return found;
}

/**
 * The config prices of a market in force at `at` (the instant the order is priced; now when omitted).
 * A value that does not parse, or has no entry that has started, is undefined: a bad row is not a price
 * (R16). Only scope 'market' rows are read, so no customer setting is reachable from here.
 */
export async function readConfigPrices(
  tx: Tx,
  market: string,
  at: Date = new Date(),
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
    if (!isConfigPriceKey(row.key)) continue;
    const entries = parseConfigPriceValue(row.key, row.value);
    const inForce = entries === null ? null : entryOfConfigPriceAt(entries, at);
    if (inForce !== null) out[row.key] = { usd: inForce.usd, unit: CONFIG_PRICE_UNIT_OF[row.key] };
  }
  return out;
}

/** Every stored config price of a market with its history, by key, for the admin panel. */
export async function readConfigPriceRows(
  tx: Tx,
  market: string,
): Promise<{ rows: ConfigPriceRow[]; invalid: ConfigPriceKey[] }> {
  if (!isMarketCode(market)) throw new TypeError("readConfigPriceRows: market is invalid");
  const found = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.market, market),
        eq(settings.scope, "market"),
        inArray(settings.key, [...CONFIG_PRICE_KEYS]),
      ),
    );
  const rows: ConfigPriceRow[] = [];
  const invalid: ConfigPriceKey[] = [];
  for (const { key, value } of found) {
    if (!isConfigPriceKey(key)) continue;
    const entries = parseConfigPriceValue(key, value);
    if (entries === null) invalid.push(key);
    else rows.push({ key, unit: CONFIG_PRICE_UNIT_OF[key], entries });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  invalid.sort();
  return { rows, invalid };
}
