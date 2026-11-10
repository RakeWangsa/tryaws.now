import type { Minor } from "../types";
import { D, isPositiveDecimal, parseDecimal, toMinor } from "./decimal";
import { PricingInputError } from "./errors";
import type { PriceQuote, QuoteInput } from "./types";
import { validateRule } from "./validate";

/**
 * Spec section 8: base = round_half_up(aws * quantity * fx * 100); each step is
 * round_half_up(basis * rate) with basis = base for "aws" and the running total for "subtotal".
 * Any input it refuses is a PricingInputError.
 */
export function quote(input: QuoteInput): PriceQuote {
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
    rate: parseDecimal(step.rate, `steps[${i}].rate`),
  }));

  const baseMinor = toMinor(aws.times(quantity).times(fx).times(100));
  let running: Minor = baseMinor;
  const steps = priced.map(({ step, rate }) => {
    const basis = step.base === "aws" ? baseMinor : running;
    const amountMinor = toMinor(new D(basis.toString()).times(rate));
    running += amountMinor;
    return { code: step.code, amountMinor };
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
