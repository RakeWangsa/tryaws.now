import type { Minor } from "../types";
import { D, isPositiveDecimal, parseDecimal, toMinor } from "./decimal";
import { PricingInputError } from "./errors";
import type { PriceQuote, QuoteInput } from "./types";
import { validateRule } from "./validate";

/**
 * What the price book (book.ts) changes in the one step with the code `markup`: another rate, and/or
 * a whole number of minor units added to the step's amount (before a later "subtotal" step sees it).
 */
export interface MarkupOverride {
  rate?: string;
  addMinor?: Minor;
}

/**
 * Spec section 8: base = round_half_up(aws * quantity * fx * 100); each step is
 * round_half_up(basis * rate) with basis = base for "aws" and the running total for "subtotal".
 * Any input it refuses is a PricingInputError.
 */
export function quote(input: QuoteInput): PriceQuote {
  return priceQuote(input, undefined);
}

/**
 * quote() with the markup step changed by the price book. The same algorithm: it passes the override
 * down and computes nothing of its own. With an empty override it is quote().
 */
export function quoteWithMarkup(input: QuoteInput, override: MarkupOverride): PriceQuote {
  return priceQuote(input, override);
}

function priceQuote(input: QuoteInput, override: MarkupOverride | undefined): PriceQuote {
  const problems = validateRule(input.rule);
  if (problems.length > 0) {
    const message = "invalid pricing rule: " + problems.map((p) => p.message).join("; ");
    throw new PricingInputError(message, problems);
  }
  const aws = parseDecimal(input.awsPriceUsd, "awsPriceUsd");
  const quantity =
    input.quantity === undefined ? new D(1) : parseDecimal(input.quantity, "quantity");
  const fx = parseDecimal(input.fxRate, "fxRate");
  if (!isPositiveDecimal(input.fxRate)) {
    const message = "fxRate must be greater than 0";
    throw new PricingInputError(message, [{ path: "fxRate", message }]);
  }
  const priced = input.rule.steps.map((step, i) => ({
    step,
    rate:
      override?.rate !== undefined && step.code === "markup"
        ? parseDecimal(override.rate, "markup rate")
        : parseDecimal(step.rate, `steps[${i}].rate`),
    // The text that priced the step, reported with it (WPU-I2). Never used in a computation.
    rateText: override?.rate !== undefined && step.code === "markup" ? override.rate : step.rate,
  }));

  const baseMinor = toMinor(aws.times(quantity).times(fx).times(100));
  let running: Minor = baseMinor;
  const steps = priced.map(({ step, rate, rateText }) => {
    const basis = step.base === "aws" ? baseMinor : running;
    const added = step.code === "markup" ? (override?.addMinor ?? 0n) : 0n;
    const amountMinor = toMinor(new D(basis.toString()).times(rate)) + added;
    running += amountMinor;
    return { code: step.code, amountMinor, rate: rateText };
  });

  return {
    currency: "BDT",
    fxRate: input.fxRate,
    ruleVersion: input.rule.version,
    baseMinor,
    steps,
    totalMinor: running,
  };
}
