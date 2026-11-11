import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { pricingRules } from "../../schema/index";
import { isUuid } from "../scope";
import { historyLimit, isFlagKeyText, isMarketCode, requireInstant } from "./args";

export interface PricingRuleRow {
  id: string; // the version of the rule
  market: string;
  productFamily: string | null;
  steps: unknown[]; // what was saved; not trusted
  effectiveFrom: Date;
}

// Only the columns that the three roles may read.
const columns = {
  id: pricingRules.id,
  market: pricingRules.market,
  productFamily: pricingRules.productFamily,
  steps: pricingRules.steps,
  effectiveFrom: pricingRules.effectiveFrom,
};

export async function readPricingRuleInForce(
  tx: Tx,
  market: string,
  productFamily: string | null,
  at: Date,
): Promise<PricingRuleRow | null> {
  requireInstant(at, "readPricingRuleInForce: at");
  if (!isMarketCode(market)) return null;
  if (productFamily !== null && !isFlagKeyText(productFamily)) return null;
  const rows = await tx
    .select(columns)
    .from(pricingRules)
    .where(
      and(
        eq(pricingRules.market, market),
        lte(pricingRules.effectiveFrom, at),
        productFamily === null
          ? isNull(pricingRules.productFamily)
          : or(eq(pricingRules.productFamily, productFamily), isNull(pricingRules.productFamily)),
      ),
    )
    // The family's own rows first (false sorts before true), then the newest start.
    .orderBy(sql`(${pricingRules.productFamily} is null)`, desc(pricingRules.effectiveFrom))
    .limit(1);
  return rows[0] ?? null;
}

export async function readPricingRules(
  tx: Tx,
  market: string,
  limit?: number,
): Promise<PricingRuleRow[]> {
  const n = historyLimit(limit);
  if (!isMarketCode(market)) return [];
  return tx
    .select(columns)
    .from(pricingRules)
    .where(eq(pricingRules.market, market))
    .orderBy(desc(pricingRules.effectiveFrom), desc(pricingRules.id))
    .limit(n);
}

export async function readPricingRuleById(tx: Tx, id: string): Promise<PricingRuleRow | null> {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const rows = await tx.select(columns).from(pricingRules).where(eq(pricingRules.id, id)).limit(1);
  return rows[0] ?? null;
}
