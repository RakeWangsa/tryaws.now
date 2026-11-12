import { and, eq, like } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isFlagKeyText, isMarketCode } from "./args";

// The price book (WPA-P1): the margin and the commission an admin sets for a product family of a
// market, with the start of each setting. One row of `settings` for each family, key
// `price_book.<family>`, scope 'market', and the value
//
//   { "v": 1, "entries": [ { "from": "<ISO instant>", "margin": { "kind", "value" },
//                            "commission": null | { "kind", "value" }, "by": "<admin id>" | null } ] }
//
// The entries are ascending by `from`. The entry in force is the last one that has started; a later
// one is a scheduled change. A row is only ever appended to (adminRepos.priceBook.save, audited with
// before and after), and the customer side reads it with web_rw and worker_rw, which already have
// SELECT on these columns of `settings`. @tc/db cannot import the engine, so the shape check below is
// a copy of validateBookTerms of packages/core/pricing; a test of core pins that they agree.

export const PRICE_BOOK_PREFIX = "price_book.";
export const PRICE_BOOK_VERSION = 1;
/** The longest history one family keeps; older entries stay in the audit log. */
export const PRICE_BOOK_MAX_ENTRIES = 50;

export interface PriceBookAmount {
  readonly kind: "percent" | "fixed";
  readonly value: string;
}

export interface PriceBookEntry {
  readonly from: Date;
  readonly margin: PriceBookAmount;
  readonly commission: PriceBookAmount | null;
  readonly by: string | null;
}

export interface PriceBookRow {
  readonly family: string;
  /** Ascending by start. */
  readonly entries: readonly PriceBookEntry[];
}

const PERCENT_TEXT = /^(\d{1,2})(?:\.(\d{1,4}))?$/;
const FIXED_TEXT = /^(0|[1-9]\d{0,8})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function priceBookKey(family: string): string {
  if (!isFlagKeyText(family)) throw new TypeError("priceBookKey: not a family name");
  return PRICE_BOOK_PREFIX + family;
}

// True when a percent fraction written as text is at most `max` whole units (5 means 5.0000). Text
// only: no number is made of a price.
function percentAtMost(text: string, max: number): boolean {
  const m = PERCENT_TEXT.exec(text);
  if (m === null) return false;
  const whole = Number(m[1]);
  return whole < max || (whole === max && /^0*$/.test(m[2] ?? ""));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An amount as stored, or null when the shape or the range is wrong. `maxPercent` is 5 for a margin, 1 for a commission. */
export function parsePriceBookAmount(value: unknown, maxPercent: number): PriceBookAmount | null {
  if (!isObject(value) || typeof value.value !== "string") return null;
  if (value.kind === "percent") {
    return percentAtMost(value.value, maxPercent) ? { kind: "percent", value: value.value } : null;
  }
  if (value.kind === "fixed") {
    return FIXED_TEXT.test(value.value) ? { kind: "fixed", value: value.value } : null;
  }
  return null;
}

export const isPriceBookMargin = (value: unknown): value is PriceBookAmount =>
  parsePriceBookAmount(value, 5) !== null;
export const isPriceBookCommission = (value: unknown): value is PriceBookAmount =>
  parsePriceBookAmount(value, 1) !== null;

/** The entries of a stored value, or null when anything in it is wrong: a bad row is not a price (R16). */
export function parsePriceBookValue(value: unknown): PriceBookEntry[] | null {
  if (!isObject(value) || value.v !== PRICE_BOOK_VERSION || !Array.isArray(value.entries)) {
    return null;
  }
  if (value.entries.length === 0 || value.entries.length > PRICE_BOOK_MAX_ENTRIES) return null;
  const out: PriceBookEntry[] = [];
  for (const raw of value.entries as unknown[]) {
    if (!isObject(raw) || typeof raw.from !== "string") return null;
    const from = new Date(raw.from);
    if (Number.isNaN(from.getTime()) || from.toISOString() !== raw.from) return null;
    const margin = parsePriceBookAmount(raw.margin, 5);
    if (margin === null) return null;
    const commission = raw.commission === null ? null : parsePriceBookAmount(raw.commission, 1);
    if (raw.commission !== null && commission === null) return null;
    const by =
      raw.by === null ? null : typeof raw.by === "string" && UUID.test(raw.by) ? raw.by : "";
    if (by === "") return null;
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.from.getTime() >= from.getTime()) return null;
    out.push({ from, margin, commission, by });
  }
  return out;
}

export function priceBookValueOf(entries: readonly PriceBookEntry[]): unknown {
  return {
    v: PRICE_BOOK_VERSION,
    entries: entries.map((e) => ({
      from: e.from.toISOString(),
      margin: { kind: e.margin.kind, value: e.margin.value },
      commission:
        e.commission === null ? null : { kind: e.commission.kind, value: e.commission.value },
      by: e.by,
    })),
  };
}

/** The entry in force at an instant: the last one that has started, or null. */
export function entryInForce(entries: readonly PriceBookEntry[], at: Date): PriceBookEntry | null {
  let found: PriceBookEntry | null = null;
  for (const entry of entries) if (entry.from.getTime() <= at.getTime()) found = entry;
  return found;
}

export type PriceBookRead =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly entries: readonly PriceBookEntry[] };

/**
 * The stored book of one family. `invalid` is a row that does not parse: the caller fails closed (it
 * prices nothing for that family) instead of pricing without a margin it cannot read (R16). Not tenant
 * data. Messages hold no input (R14).
 */
export async function readPriceBook(
  tx: Tx,
  market: string,
  family: string,
): Promise<PriceBookRead> {
  if (!isMarketCode(market)) throw new TypeError("readPriceBook: market is invalid");
  const key = priceBookKey(family);
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), eq(settings.market, market), eq(settings.scope, "market")))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { state: "none" };
  const entries = parsePriceBookValue(row.value);
  return entries === null ? { state: "invalid" } : { state: "ok", entries };
}

/** Every family with a stored book in a market, by family, for the admin panel. */
export async function readPriceBooks(
  tx: Tx,
  market: string,
): Promise<{ rows: PriceBookRow[]; invalid: string[] }> {
  if (!isMarketCode(market)) throw new TypeError("readPriceBooks: market is invalid");
  const found = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.market, market),
        eq(settings.scope, "market"),
        like(settings.key, PRICE_BOOK_PREFIX + "%"),
      ),
    );
  const rows: PriceBookRow[] = [];
  const invalid: string[] = [];
  for (const { key, value } of found) {
    const family = key.slice(PRICE_BOOK_PREFIX.length);
    if (!isFlagKeyText(family)) continue;
    const entries = parsePriceBookValue(value);
    if (entries === null) invalid.push(family);
    else rows.push({ family, entries });
  }
  rows.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  invalid.sort();
  return { rows, invalid };
}
