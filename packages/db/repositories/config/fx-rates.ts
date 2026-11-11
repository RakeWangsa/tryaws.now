import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { fxRates } from "../../schema/index";
import { historyLimit, isMarketCode, requireInstant } from "./args";

export interface FxRateRow {
  id: string;
  market: string;
  rate: string;
  effectiveFrom: Date;
}

// Only the columns that the three roles may read; who set a row is in the audit log. The canonical
// text comes from PostgreSQL, so "127.000000" is never seen by the engine.
const columns = {
  id: fxRates.id,
  market: fxRates.market,
  rate: sql<string>`trim_scale(${fxRates.rate})::text`,
  effectiveFrom: fxRates.effectiveFrom,
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

export async function readFxRates(tx: Tx, market: string, limit?: number): Promise<FxRateRow[]> {
  const n = historyLimit(limit);
  if (!isMarketCode(market)) return [];
  return tx
    .select(columns)
    .from(fxRates)
    .where(eq(fxRates.market, market))
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
