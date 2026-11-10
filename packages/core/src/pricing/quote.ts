import Big from "big.js";
import type { Minor } from "../types";
import { parseDecimal, toMinor } from "./decimal";
import type { PriceQuote, QuoteInput } from "./types";

/**
 * Spec section 8: base = round_half_up(aws * quantity * fx * 100); each step is
 * round_half_up(basis * rate) with basis = base for "aws" and the running total for "subtotal".
 */
export function quote(input: QuoteInput): PriceQuote {
  const aws = parseDecimal(input.awsPriceUsd, "awsPriceUsd");
  const quantity = parseDecimal(input.quantity ?? "1", "quantity");
  const fx = parseDecimal(input.fxRate, "fxRate");
  const rates = input.rule.steps.map((step) =>
    parseDecimal(step.rate, `rate of step ${step.code}`),
  );

  const baseMinor = toMinor(aws.times(quantity).times(fx).times(100));
  let running: Minor = baseMinor;
  const steps = input.rule.steps.map((step, i) => {
    const basis = step.base === "aws" ? baseMinor : running;
    const amountMinor = toMinor(new Big(basis.toString()).times(rates[i]!));
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
