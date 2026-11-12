import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isMarketCode } from "../config/args";
import {
  CONFIG_PRICE_MAX_ENTRIES,
  CONFIG_PRICE_TEXT,
  configPriceValueOf,
  entryOfConfigPriceAt,
  isConfigPriceKey,
  parseConfigPriceValue,
  readConfigPriceRows,
  type ConfigPriceEntry,
  type ConfigPriceKey,
  type ConfigPriceRow,
} from "../config/config-price";
import { lockConfigPriceWrites } from "../config/locks";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /pricing/config, the prices that no AWS API fills (WPU-G10): block storage and snapshot per
// GB-month, the load balancer and the hosted zone per month. `finance` and `superadmin`, the roles of the
// pricing area; the role check here is a second layer behind requireAdmin(roles) of the app (R9, R16).
// Every write goes through `audited` (R10): actor, reason, IP and target are stored with the before and
// after values, in the same transaction. Rows are only appended to; nothing is deleted. A price reaches
// the orders priced after its start; an order already placed keeps its stored snapshot.
const ROLES: readonly AdminRole[] = ["finance", "superadmin"];
/** A change may start at most this many days after the call that saves it (as the book and the rates). */
export const CONFIG_PRICE_MAX_SCHEDULE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConfigPriceInput {
  market: string;
  key: ConfigPriceKey;
  /** Plain decimal text, at most 4 decimals, above 0. */
  usd: string;
  effectiveFrom: Date;
  at: Date; // the caller's clock reading
}

export interface ConfigPriceSaved {
  key: ConfigPriceKey;
  /** The entry that was stored, or the one already there. */
  entry: ConfigPriceEntry;
  /** A later change that is still waiting, if any. */
  laterChangePending: Date | null;
}

export interface ConfigPricesAdminRepo {
  read(market: string): Promise<Written<{ rows: ConfigPriceRow[]; invalid: ConfigPriceKey[] }>>;
  save(input: ConfigPriceInput, reason: string): Promise<Written<ConfigPriceSaved>>;
}

class Conflict extends Error {}

const isInstant = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const stamp = (entry: ConfigPriceEntry | null) =>
  entry === null ? null : { from: entry.from.toISOString(), usd: entry.usd };

export function configPricesAdminRepo(scope: AdminScope): ConfigPricesAdminRepo {
  const { role } = scope.actor;
  return {
    async read(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      return { ok: true, value: await readConfigPriceRows(scope.tx, market), replayed: false };
    },

    async save(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, key, usd, effectiveFrom, at } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        !isMarketCode(market) ||
        !isConfigPriceKey(key) ||
        typeof usd !== "string" ||
        !CONFIG_PRICE_TEXT.test(usd) ||
        !/[1-9]/.test(usd) ||
        !isInstant(effectiveFrom) ||
        !isInstant(at) ||
        effectiveFrom.getTime() < at.getTime() ||
        effectiveFrom.getTime() - at.getTime() > CONFIG_PRICE_MAX_SCHEDULE_DAYS * DAY_MS
      ) {
        return refused("validation");
      }
      const wanted: ConfigPriceEntry = { from: effectiveFrom, usd, by: scope.actor.adminId };
      const { tx, actor } = scope;
      try {
        return await audited(
          scope,
          {
            action: "config_price.save",
            targetType: "config_price",
            targetId: `${market}/${key}@${effectiveFrom.toISOString()}`,
            reason,
          },
          async () => {
            // Serializes the saves of one market: the read below sees every committed row.
            await lockConfigPriceWrites(tx, market);
            const existing = await tx.execute<{ id: string; value: unknown }>(
              sql`select id, value from settings
                  where key = ${key} and market = ${market} and scope = 'market' and scope_id is null`,
            );
            const row = existing.rows[0];
            // A stored row that does not parse is replaced by this save (the audit log holds the old
            // value); it is never read as a price (R16).
            const entries = row === undefined ? [] : (parseConfigPriceValue(key, row.value) ?? []);
            const inForce = entryOfConfigPriceAt(entries, at);
            const before = stamp(inForce);
            const later = (): Date | null =>
              entries.find((e) => e.from.getTime() > at.getTime())?.from ?? null;

            const atStart = entries.find((e) => e.from.getTime() === effectiveFrom.getTime());
            if (atStart !== undefined) {
              if (atStart.usd !== wanted.usd) throw new Conflict();
              const value = { key, entry: atStart, laterChangePending: later() };
              return { value, replayed: true, before, after: stamp(atStart) };
            }
            if (
              inForce !== null &&
              effectiveFrom.getTime() === at.getTime() &&
              inForce.usd === wanted.usd
            ) {
              // Saving the price in force does not withdraw a scheduled change: it reports it.
              const value = { key, entry: inForce, laterChangePending: later() };
              return { value, replayed: true, before, after: stamp(inForce) };
            }

            const next = [...entries, wanted].sort((a, b) => a.from.getTime() - b.from.getTime());
            const kept = next.slice(-CONFIG_PRICE_MAX_ENTRIES);
            const json = JSON.stringify(configPriceValueOf(key, kept));
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
            const value = { key, entry: wanted, laterChangePending: null };
            return { value, replayed: false, before, after: stamp(wanted) };
          },
        );
      } catch (error) {
        if (error instanceof Conflict) return refused("conflict");
        throw error;
      }
    },
  };
}
