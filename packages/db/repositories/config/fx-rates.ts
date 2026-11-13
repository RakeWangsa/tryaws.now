import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { fxRates } from "../../schema/index";
import { historyLimit, isMarketCode, requireInstant } from "./args";

export interface FxRateRow {
  id: string;
  market: string;
  rate: string;
  effectiveFrom: Date;
  /**
   * WPU-Y9. When the rate was entered (approved). The freshness of a rate is measured from here, never from
   * `effectiveFrom`, which can be up to 7 days after the entry.
   */
  createdAt: Date;
}

// Only the columns that the three roles may read; who set a row is in the audit log. The canonical
// text comes from PostgreSQL, so "127.000000" is never seen by the engine.
const columns = {
  id: fxRates.id,
  market: fxRates.market,
  rate: sql<string>`trim_scale(${fxRates.rate})::text`,
  effectiveFrom: fxRates.effectiveFrom,
  createdAt: fxRates.createdAt,
};

export async function readFxRateInForce(
  tx: Tx,
  market: string,
  at: Date,
): Promise<FxRateRow | null> {
  requireInstant(at, "readFxRateInForce: at");
  if (!isMarketCode(market)) return null;
  const rows = await tx
    .select(columns)
    .from(fxRates)
    .where(and(eq(fxRates.market, market), lte(fxRates.effectiveFrom, at)))
    .orderBy(desc(fxRates.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The rates of a market, newest start first. With `at`, only the rates that have started by then (WPU-Y9: the rate
 * in force and the one before it, never a rate scheduled for later).
 */
export async function readFxRates(
  tx: Tx,
  market: string,
  limit?: number,
  at?: Date,
): Promise<FxRateRow[]> {
  const n = historyLimit(limit);
  if (!isMarketCode(market)) return [];
  if (at !== undefined) requireInstant(at, "readFxRates: at");
  return tx
    .select(columns)
    .from(fxRates)
    .where(
      at === undefined
        ? eq(fxRates.market, market)
        : and(eq(fxRates.market, market), lte(fxRates.effectiveFrom, at)),
    )
    .orderBy(desc(fxRates.effectiveFrom), desc(fxRates.id))
    .limit(n);
}

// What numeric(12,6) keeps without rounding or overflow, above 0. The repository's own copy of
// isFxRateText of core; a test checks that the two agree.
export function isStorableFxRate(text: unknown): text is string {
  return (
    typeof text === "string" &&
    /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(text) &&
    /[1-9]/.test(text)
  );
}
