import type { FxRateRow, Tx } from "@tc/db";
import {
  PricingInputError,
  problemFields,
  quote,
  toSnapshot,
  type PriceQuote,
  type PriceSnapshot,
  type PricingRule,
} from "../pricing/index";
import type { Clock, Result } from "../types";
import { readInForce, ruleOf, scopeProblems, type Scope } from "./common";

export interface PricingInForce {
  pricedAt: Date;
  fx: FxRateRow;
  rule: { id: string; productFamily: string | null; effectiveFrom: Date; value: PricingRule };
}

/**
 * The rate and the rule that price an item at the instant the clock reads (once). R16: no rate,
 * no rule, or a stored rule that the engine refuses, and nothing is priced.
 */
export async function pricingInForce(
  tx: Tx,
  scope: Scope,
  clock: Clock,
): Promise<Result<PricingInForce>> {
  const pricedAt = clock.now();
  const problems = scopeProblems(scope);
  if (Object.keys(problems).length > 0) return { ok: false, error: "validation", fields: problems };
  const { fx, row } = await readInForce(tx, scope, pricedAt);
  if (fx === null) return { ok: false, error: "not_found", fields: { fxRate: "not_in_force" } };
  if (row === null) return { ok: false, error: "not_found", fields: { rule: "not_in_force" } };
  const value = ruleOf(row);
  if (value === null) {
    return { ok: false, error: "internal", fields: { rule: "stored_rule_invalid" } };
  }
  return {
    ok: true,
    value: {
      pricedAt,
      fx,
      rule: {
        id: row.id,
        productFamily: row.productFamily,
        effectiveFrom: row.effectiveFrom,
        value,
      },
    },
  };
}

export interface PricedItem {
  quote: PriceQuote;
  snapshot: PriceSnapshot;
  inForce: PricingInForce;
}

/** Prices one item with the rate and the rule of one instant, and builds the snapshot an order stores. */
export async function quoteInForce(
  tx: Tx,
  input: { market: string; productFamily: string | null; awsPriceUsd: string; quantity?: string },
  clock: Clock,
): Promise<Result<PricedItem>> {
  const found = await pricingInForce(
    tx,
    { market: input.market, productFamily: input.productFamily },
    clock,
  );
  if (!found.ok) return found;
  const inForce = found.value;
  try {
    const priced = quote({
      awsPriceUsd: input.awsPriceUsd,
      ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
      fxRate: inForce.fx.rate,
      rule: inForce.rule.value,
    });
    const snapshot = toSnapshot(priced, {
      awsPriceUsd: input.awsPriceUsd,
      ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
      pricedAt: inForce.pricedAt,
    });
    return { ok: true, value: { quote: priced, snapshot, inForce } };
  } catch (error) {
    if (error instanceof PricingInputError) {
      return { ok: false, error: "validation", fields: problemFields(error.problems) };
    }
    throw error;
  }
}
