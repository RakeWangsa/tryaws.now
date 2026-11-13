import { entryInForce, readPriceBook, type FxRateRow, type Tx } from "@tc/db";
import type { ChargeInputs } from "../pricing/charge-snapshot";
import {
  PricingInputError,
  isBookTerms,
  problemFields,
  quoteWithBook,
  toSnapshot,
  type BookTerms,
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
  /**
   * The margin and the commission of the family in force at `pricedAt` (the price book, WPA-P1), or
   * null when the family has none. A family with no book is priced by the rule alone.
   */
  book: BookTerms | null;
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
  // The price book of the family, at the same instant. A stored book that does not parse prices
  // nothing: pricing without a margin that cannot be read would sell below the intended price (R16).
  let book: BookTerms | null = null;
  if (scope.productFamily !== null) {
    const stored = await readPriceBook(tx, scope.market, scope.productFamily);
    if (stored.state === "invalid") {
      return { ok: false, error: "internal", fields: { book: "stored_book_invalid" } };
    }
    if (stored.state === "ok") {
      const entry = entryInForce(stored.entries, pricedAt);
      if (entry !== null) {
        const terms = { margin: entry.margin, commission: entry.commission };
        if (!isBookTerms(terms)) {
          return { ok: false, error: "internal", fields: { book: "stored_book_invalid" } };
        }
        book = terms;
      }
    }
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
      book,
    },
  };
}

export interface PricedItem {
  quote: PriceQuote;
  snapshot: PriceSnapshot;
  inForce: PricingInForce;
  /**
   * WPU-Y2: the exact inputs of this price (rate with its id and time, rule id, the price book terms, the
   * AWS price and the quantity). buildChargeSnapshot turns them into what a charge stores.
   */
  charge: ChargeInputs;
  /** The margin in the quote and the reseller's share of it, in paisa (not part of the snapshot). */
  marginMinor: bigint;
  commissionMinor: bigint;
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
    const booked = quoteWithBook(
      {
        awsPriceUsd: input.awsPriceUsd,
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
        fxRate: inForce.fx.rate,
        rule: inForce.rule.value,
      },
      inForce.book,
    );
    const priced = booked.quote;
    const snapshot = toSnapshot(priced, {
      awsPriceUsd: input.awsPriceUsd,
      ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
      pricedAt: inForce.pricedAt,
    });
    return {
      ok: true,
      value: {
        quote: priced,
        snapshot,
        charge: {
          pricedAt: inForce.pricedAt,
          awsPriceUsd: input.awsPriceUsd,
          quantity: input.quantity ?? "1",
          fx: {
            id: inForce.fx.id,
            rate: inForce.fx.rate,
            effectiveFrom: inForce.fx.effectiveFrom,
          },
          rule: { id: inForce.rule.id, version: inForce.rule.value.version },
          book: inForce.book,
          quote: priced,
        },
        inForce,
        marginMinor: booked.marginMinor,
        commissionMinor: booked.commissionMinor,
      },
    };
  } catch (error) {
    if (error instanceof PricingInputError) {
      return { ok: false, error: "validation", fields: problemFields(error.problems) };
    }
    throw error;
  }
}
