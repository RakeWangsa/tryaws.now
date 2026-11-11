import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { fxRates } from "../../schema/index";
import { isMarketCode } from "../config/args";
import { isStorableFxRate, type FxRateRow } from "../config/fx-rates";
import { lockFxRateWrites } from "../config/locks";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { audited } from "./audited";
import type { AdminScope } from "./index";

export interface FxRateInput {
  market: string;
  rate: string;
  effectiveFrom: Date;
  at: Date; // the caller's clock reading
  approvedBy?: string; // the second admin of a large change, verified by the caller
}

export type FxRateSaved = FxRateRow & { laterChangePending: Date | null };

export interface FxRatesAdminRepo {
  set(input: FxRateInput, reason: string): Promise<Written<FxRateSaved>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Conflict extends Error {}

const isInstant = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const stamp = (row: FxRateRow) => ({
  id: row.id,
  market: row.market,
  rate: row.rate,
  effectiveFrom: row.effectiveFrom.toISOString(),
});

export function fxRatesAdminRepo(scope: AdminScope): FxRatesAdminRepo {
  return {
    async set(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, rate, effectiveFrom, at, approvedBy } = input;
      if (
        !isMarketCode(market) ||
        !isStorableFxRate(rate) ||
        !isInstant(effectiveFrom) ||
        !isInstant(at) ||
        effectiveFrom.getTime() < at.getTime() ||
        (approvedBy !== undefined && (typeof approvedBy !== "string" || !isUuid(approvedBy)))
      ) {
        return refused("validation");
      }
      const approver = approvedBy?.toLowerCase();
      const { tx, actor } = scope;
      try {
        return await audited(
          scope,
          {
            action: "fx_rate.set",
            targetType: "fx_rate",
            targetId: `${market}@${effectiveFrom.toISOString()}`,
            reason,
          },
          async () => {
            // Serializes the saves of one market: the reads below see every committed row.
            await lockFxRateWrites(tx, market);
            const columns = {
              id: fxRates.id,
              market: fxRates.market,
              rate: sql<string>`trim_scale(${fxRates.rate})::text`,
              effectiveFrom: fxRates.effectiveFrom,
              same: sql<boolean>`(${fxRates.rate} = ${rate}::numeric)`,
            };
            const [atStart] = await tx
              .select(columns)
              .from(fxRates)
              .where(and(eq(fxRates.market, market), eq(fxRates.effectiveFrom, effectiveFrom)))
              .limit(1);
            const [inForce] = await tx
              .select(columns)
              .from(fxRates)
              .where(and(eq(fxRates.market, market), lte(fxRates.effectiveFrom, at)))
              .orderBy(desc(fxRates.effectiveFrom))
              .limit(1);
            const before = inForce ? stamp(inForce) : null;
            const plain = (r: FxRateRow): FxRateRow => ({
              id: r.id,
              market: r.market,
              rate: r.rate,
              effectiveFrom: r.effectiveFrom,
            });
            if (atStart) {
              if (!atStart.same) throw new Conflict();
              const value = { ...plain(atStart), laterChangePending: null };
              return { value, replayed: true, before, after: stamp(value) };
            }
            if (inForce?.same && effectiveFrom.getTime() === at.getTime()) {
              // Saving the value in force does not withdraw a scheduled change: it reports it.
              const [later] = await tx
                .select({ effectiveFrom: fxRates.effectiveFrom })
                .from(fxRates)
                .where(and(eq(fxRates.market, market), gt(fxRates.effectiveFrom, at)))
                .orderBy(asc(fxRates.effectiveFrom))
                .limit(1);
              const value = { ...plain(inForce), laterChangePending: later?.effectiveFrom ?? null };
              return { value, replayed: true, before, after: stamp(value) };
            }
            // Only the granted columns: a Drizzle insert() would name created_at (42501).
            const result = await tx.execute(
              sql`insert into fx_rates (id, market, rate, effective_from, set_by)
                  values (${uuidv7()}, ${market}, ${rate}::numeric, ${effectiveFrom}, ${actor.adminId})
                  on conflict (market, effective_from) do nothing
                  returning id, trim_scale(rate)::text as rate`,
            );
            const inserted = result.rows[0] as unknown as { id: string; rate: string } | undefined;
            // Cannot happen while the lock is held (every other saver of the market waits or has
            // finished); a guard only (open point 20).
            if (!inserted) {
              throw new Error("fx_rates: a rate for this start was saved at the same moment");
            }
            const value: FxRateSaved = {
              id: inserted.id,
              market,
              rate: inserted.rate,
              effectiveFrom,
              laterChangePending: null,
            };
            return {
              value,
              replayed: false,
              before,
              after: { ...stamp(value), ...(approver ? { approvedBy: approver } : {}) },
            };
          },
        );
      } catch (error) {
        if (error instanceof Conflict) return refused("conflict");
        throw error;
      }
    },
  };
}
