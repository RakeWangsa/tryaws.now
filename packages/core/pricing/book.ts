import type { Minor } from "../types";
import { D, decimalAtMost, isPlainDecimal, parseDecimal, toMinor } from "./decimal";
import { PricingInputError, type PricingProblem } from "./errors";
import { quote, quoteWithMarkup } from "./quote";
import type { PriceQuote, QuoteInput } from "./types";

// The price book: what an admin sets for a product family on top of the AWS cost, the rate and the
// rule (WPA-P1). Two terms.
//
//   margin      the profit. A percent is the rate of the rule's `markup` step (a fraction of the AWS
//               base: "0.15" is 15 percent). A fixed margin is whole paisa for each billing unit (a
//               server, a GB-month) times the quantity of the order, added to the amount of the
//               `markup` step, so a "subtotal" step after it sees it. Either way the margin posts to
//               the account of `markup` (markup_income): no new posting and no change to the ledger.
//   commission  the share of the margin that goes to a reseller. A percent of the margin, or whole
//               paisa for each unit; never more than the margin. It is a figure for the panel and the
//               reports: it does not change what the customer pays and posts nothing.
//
// Rounding is half up everywhere (the engine's toMinor). All text, never a number (R4).

export type BookAmount =
  | { readonly kind: "percent"; readonly value: string }
  | { readonly kind: "fixed"; readonly value: string };

export interface BookTerms {
  readonly margin: BookAmount;
  readonly commission: BookAmount | null;
}

export interface BookedQuote {
  quote: PriceQuote;
  /** The margin in the quote: the amount of the markup step. 0 without terms. */
  marginMinor: Minor;
  /** The reseller's share of the margin. 0 without terms or without a commission. */
  commissionMinor: Minor;
}

/** A margin of at most 500 percent of the AWS base. */
export const BOOK_MAX_MARGIN_PERCENT = "5";
/** A commission of at most the whole margin. */
export const BOOK_MAX_COMMISSION_PERCENT = "1";
/** The kinds an amount may have. */
export const BOOK_KINDS = Object.freeze(["percent", "fixed"] as const);

const PERCENT_TEXT = /^\d{1,2}(\.\d{1,4})?$/;
const FIXED_TEXT = /^(0|[1-9]\d{0,8})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function amountProblem(value: unknown, path: string, maxPercent: string): string | null {
  if (!isObject(value)) return `${path} is not an object`;
  if (value.kind === "percent") {
    const v = value.value;
    if (typeof v !== "string" || !PERCENT_TEXT.test(v) || !isPlainDecimal(v)) {
      return `${path} is not a plain percent fraction with at most 4 decimals`;
    }
    return decimalAtMost(v, maxPercent) ? null : `${path} is above ${maxPercent}`;
  }
  if (value.kind === "fixed") {
    const v = value.value;
    return typeof v === "string" && FIXED_TEXT.test(v)
      ? null
      : `${path} is not a whole number of paisa below 1000000000`;
  }
  return `${path} has an unknown kind`;
}

/** The problems of a set of terms; empty when they are valid. The shape is checked too (it comes from JSON). */
export function validateBookTerms(terms: unknown): PricingProblem[] {
  if (!isObject(terms)) return [{ path: "", message: "terms are not an object" }];
  const problems: PricingProblem[] = [];
  const margin = amountProblem(terms.margin, "margin", BOOK_MAX_MARGIN_PERCENT);
  if (margin !== null) problems.push({ path: "margin", message: margin });
  if (terms.commission !== null) {
    const commission = amountProblem(terms.commission, "commission", BOOK_MAX_COMMISSION_PERCENT);
    if (commission !== null) problems.push({ path: "commission", message: commission });
  }
  return problems;
}

export function isBookTerms(terms: unknown): terms is BookTerms {
  return validateBookTerms(terms).length === 0;
}

/**
 * Prices one item with the engine and the terms of the book. No terms is quote() exactly. The terms
 * are checked first, and a rule without a `markup` step cannot carry a margin: both are a
 * PricingInputError (the caller fails closed, R16).
 */
export function quoteWithBook(input: QuoteInput, terms: BookTerms | null): BookedQuote {
  if (terms === null) {
    const plain = quote(input);
    const markup = plain.steps.find((s) => s.code === "markup");
    return { quote: plain, marginMinor: markup?.amountMinor ?? 0n, commissionMinor: 0n };
  }
  const problems = validateBookTerms(terms);
  if (problems.length > 0 || !isBookTerms(terms)) {
    throw new PricingInputError("invalid price book terms", problems);
  }
  if (!input.rule.steps.some((s) => s.code === "markup")) {
    const message = "the rule has no markup step, so it cannot carry a margin";
    throw new PricingInputError(message, [{ path: "rule", message }]);
  }
  const quantity =
    input.quantity === undefined ? new D(1) : parseDecimal(input.quantity, "quantity");
  const unitsOf = (paisa: string): Minor => toMinor(new D(paisa).times(quantity));

  const priced =
    terms.margin.kind === "percent"
      ? quoteWithMarkup(input, { rate: terms.margin.value })
      : quoteWithMarkup(input, { rate: "0", addMinor: unitsOf(terms.margin.value) });
  const marginMinor = priced.steps.find((s) => s.code === "markup")?.amountMinor ?? 0n;

  let commissionMinor: Minor = 0n;
  if (terms.commission !== null && marginMinor > 0n) {
    commissionMinor =
      terms.commission.kind === "percent"
        ? toMinor(
            new D(marginMinor.toString()).times(parseDecimal(terms.commission.value, "commission")),
          )
        : unitsOf(terms.commission.value);
    if (commissionMinor > marginMinor) commissionMinor = marginMinor;
  }
  return { quote: priced, marginMinor, commissionMinor };
}
