import { parseDecimal } from "./decimal";
import type { PricingRule } from "./types";

/** Spec section 8: the ledger account each step code posts to. */
export const STEP_ACCOUNTS = {
  korea_vat: "vat_korea_payable",
  bd_vat: "vat_bd_payable",
  processing_fee: "processing_fee_income",
  markup: "markup_income",
} as const;

const isBlank = (text: string): boolean => text.trim() === "";

/**
 * The problems of a rule, grouped by condition and, inside one condition, in step order.
 * Empty when the rule is valid. The rate check uses parseDecimal, so it cannot disagree with quote.
 */
export function validateRule(rule: PricingRule): string[] {
  const problems: string[] = [];
  const { steps } = rule;

  if (isBlank(rule.version)) problems.push("version is empty");

  for (const step of steps) {
    if (!Object.hasOwn(STEP_ACCOUNTS, step.code)) {
      problems.push(`step ${step.code} has no ledger account`);
    }
  }

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.code) && !repeated.has(step.code)) {
      repeated.add(step.code);
      problems.push(`step ${step.code} appears twice`);
    }
    seen.add(step.code);
  }

  for (const step of steps) {
    try {
      parseDecimal(step.rate, `rate of step ${step.code}`);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      problems.push(error.message);
    }
  }

  for (const step of steps) {
    if (step.base !== "aws" && step.base !== "subtotal") {
      problems.push(`base of step ${step.code} must be aws or subtotal`);
    }
  }

  steps.forEach((step, i) => {
    if (step.base === "subtotal" && i !== steps.length - 1) {
      problems.push(`step ${step.code} has base subtotal and is not the last step`);
    }
  });

  for (const step of steps) {
    if (isBlank(step.label.bn) || isBlank(step.label.en)) {
      problems.push(`label of step ${step.code} must have a Bangla and an English text`);
    }
  }

  return problems;
}
