import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isFlagKeyText, isMarketCode } from "../config/args";
import { isFeatureFlagKey } from "../config/feature-flags";
import { lockPriceBookWrites } from "../config/locks";
import {
  PRICE_BOOK_MAX_ENTRIES,
  entryInForce,
  isPriceBookCommission,
  isPriceBookMargin,
  parsePriceBookValue,
  priceBookKey,
  priceBookValueOf,
  readPriceBooks,
  type PriceBookAmount,
  type PriceBookEntry,
  type PriceBookRow,
} from "../config/price-book";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /pricing, the price book (WPA-P1): the margin and the commission of a product family, with the
// start of each setting, and the base cost of the families that no AWS API fills. `finance` and
// `superadmin` read and write; the role check here is a second layer behind requireAdmin(roles) of
// the app (R9, R16). Every write goes through `audited` (R10): actor, reason, IP and target are stored
// with the before and after values, in the same transaction. Rows are only appended to (the book) or
// have one column changed under audit (the base cost); nothing is deleted. A change reaches the orders
// that are priced after its start; an order already placed keeps its stored snapshot.
const ROLES: readonly AdminRole[] = ["finance", "superadmin"];

/** The families whose base cost an admin sets: no AWS API fills them and the catalog sync never writes them. */
export const ADMIN_PRICED_FAMILIES: readonly string[] = Object.freeze(["disk"]);
/** A change may start at most this many days after the call that saves it (as the rules and the rates). */
export const PRICE_BOOK_MAX_SCHEDULE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_COST_TEXT = /^\d{1,8}(\.\d{1,4})?$/;

export interface PriceBookInput {
  market: string;
  family: string;
  margin: PriceBookAmount;
  commission: PriceBookAmount | null;
  effectiveFrom: Date;
  at: Date; // the caller's clock reading
}

export interface PriceBookSaved {
  family: string;
  /** The entry that was stored, or the one already there. */
  entry: PriceBookEntry;
  /** A later change that is still waiting, if any. */
  laterChangePending: Date | null;
}

export interface BaseCostInput {
  catalogProductId: string;
  /** numeric(12,4) as text: plain decimal, at most 4 decimals, above 0. */
  awsPriceUsd: string;
}

export interface BaseCostSaved {
  catalogProductId: string;
  family: string;
  region: string;
  awsPriceUsd: string;
}

export interface PriceBookAdminRepo {
  read(market: string): Promise<Written<{ rows: PriceBookRow[]; invalid: string[] }>>;
  save(input: PriceBookInput, reason: string): Promise<Written<PriceBookSaved>>;
  setBaseCost(input: BaseCostInput, reason: string): Promise<Written<BaseCostSaved>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Conflict extends Error {}

const isInstant = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const sameAmount = (a: PriceBookAmount | null, b: PriceBookAmount | null): boolean =>
  a === null || b === null ? a === b : a.kind === b.kind && a.value === b.value;

const stamp = (entry: PriceBookEntry | null) =>
  entry === null
    ? null
    : {
        from: entry.from.toISOString(),
        margin: entry.margin,
        commission: entry.commission,
      };

export function priceBookAdminRepo(scope: AdminScope): PriceBookAdminRepo {
  const { role } = scope.actor;
  return {
    async read(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      return { ok: true, value: await readPriceBooks(scope.tx, market), replayed: false };
    },

    async save(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, family, margin, commission, effectiveFrom, at } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        !isMarketCode(market) ||
        typeof family !== "string" ||
        !isFlagKeyText(family) ||
        !isFeatureFlagKey(family) ||
        !isPriceBookMargin(margin) ||
        (commission !== null && !isPriceBookCommission(commission)) ||
        !isInstant(effectiveFrom) ||
        !isInstant(at) ||
        effectiveFrom.getTime() < at.getTime() ||
        effectiveFrom.getTime() - at.getTime() > PRICE_BOOK_MAX_SCHEDULE_DAYS * DAY_MS
      ) {
        return refused("validation");
      }
      // Only the fields that are stored, so a request cannot add keys to the row.
      const wanted: PriceBookEntry = {
        from: effectiveFrom,
        margin: { kind: margin.kind, value: margin.value },
        commission: commission === null ? null : { kind: commission.kind, value: commission.value },
        by: scope.actor.adminId,
      };
      const { tx, actor } = scope;
      const key = priceBookKey(family);
      try {
        return await audited(
          scope,
          {
            action: "price_book.save",
            targetType: "price_book",
            targetId: `${market}/${family}@${effectiveFrom.toISOString()}`,
            reason,
          },
          async () => {
            // Serializes the saves of one market: the read below sees every committed row.
            await lockPriceBookWrites(tx, market);
            const existing = await tx.execute<{ id: string; value: unknown }>(
              sql`select id, value from settings
                  where key = ${key} and market = ${market} and scope = 'market' and scope_id is null`,
            );
            const row = existing.rows[0];
            // A stored row that does not parse is replaced by this save (the audit log holds the old
            // value); it is never read as a price (R16).
            const entries = row === undefined ? [] : (parsePriceBookValue(row.value) ?? []);
            const inForce = entryInForce(entries, at);
            const before = stamp(inForce);
            const later = (): Date | null =>
              entries.find((e) => e.from.getTime() > at.getTime())?.from ?? null;

            const atStart = entries.find((e) => e.from.getTime() === effectiveFrom.getTime());
            if (atStart !== undefined) {
              if (
                !sameAmount(atStart.margin, wanted.margin) ||
                !sameAmount(atStart.commission, wanted.commission)
              ) {
                throw new Conflict();
              }
              const value = { family, entry: atStart, laterChangePending: later() };
              return { value, replayed: true, before, after: stamp(atStart) };
            }
            if (
              inForce !== null &&
              effectiveFrom.getTime() === at.getTime() &&
              sameAmount(inForce.margin, wanted.margin) &&
              sameAmount(inForce.commission, wanted.commission)
            ) {
              // Saving the terms in force does not withdraw a scheduled change: it reports it.
              const value = { family, entry: inForce, laterChangePending: later() };
              return { value, replayed: true, before, after: stamp(inForce) };
            }

            const next = [...entries, wanted].sort((a, b) => a.from.getTime() - b.from.getTime());
            const kept = next.slice(-PRICE_BOOK_MAX_ENTRIES);
            const json = JSON.stringify(priceBookValueOf(kept));
            // Only the granted columns: a Drizzle insert() would name created_at (42501).
            if (row === undefined) {
              await tx.execute(
                sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                    values (${uuidv7()}, ${key}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
              );
            } else {
              await tx.execute(
                sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                    where id = ${row.id}`,
              );
            }
            const value = { family, entry: wanted, laterChangePending: null };
            return { value, replayed: false, before, after: stamp(wanted) };
          },
        );
      } catch (error) {
        if (error instanceof Conflict) return refused("conflict");
        throw error;
      }
    },

    async setBaseCost(input, reason) {
      const { catalogProductId, awsPriceUsd } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        typeof catalogProductId !== "string" ||
        !isUuid(catalogProductId) ||
        typeof awsPriceUsd !== "string" ||
        !BASE_COST_TEXT.test(awsPriceUsd) ||
        !/[1-9]/.test(awsPriceUsd)
      ) {
        return refused("validation");
      }
      const { tx } = scope;
      const id = catalogProductId.toLowerCase();
      try {
        return await audited(
          scope,
          {
            action: "catalog_price.set_base",
            targetType: "catalog_product",
            targetId: id,
            reason,
          },
          async () => {
            const found = await tx.execute<{
              family: string;
              region: string;
              price: string;
              same: boolean;
            }>(
              sql`select family, region, trim_scale(aws_price_usd)::text as price,
                         (aws_price_usd = ${awsPriceUsd}::numeric) as same
                  from catalog_products where id = ${id}`,
            );
            const row = found.rows[0];
            if (row === undefined) throw new Missing();
            // The synced families are the AWS API's: an admin does not overwrite a price that the
            // next sync would write back.
            if (!ADMIN_PRICED_FAMILIES.includes(row.family)) throw new NotAllowed();
            const saved = (price: string): BaseCostSaved => ({
              catalogProductId: id,
              family: row.family,
              region: row.region,
              awsPriceUsd: price,
            });
            const was = { awsPriceUsd: row.price, family: row.family, region: row.region };
            if (row.same) {
              return { value: saved(row.price), replayed: true, before: was, after: was };
            }
            // Only the granted column (0009); no RETURNING, nothing but the one column is written.
            await tx.execute(
              sql`update catalog_products set aws_price_usd = ${awsPriceUsd}::numeric where id = ${id}`,
            );
            const done = await tx.execute<{ price: string }>(
              sql`select trim_scale(aws_price_usd)::text as price from catalog_products where id = ${id}`,
            );
            const price = done.rows[0]?.price ?? awsPriceUsd;
            return {
              value: saved(price),
              replayed: false,
              before: was,
              after: { awsPriceUsd: price, family: row.family, region: row.region },
            };
          },
        );
      } catch (error) {
        if (error instanceof Missing) return refused("not_found");
        if (error instanceof NotAllowed) return refused("validation");
        throw error;
      }
    },
  };
}

class Missing extends Error {}
class NotAllowed extends Error {}
