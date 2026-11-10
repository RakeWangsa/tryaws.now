import { parseDecimal } from "./decimal";
import type { PricingRule } from "./types";

/** Spec section 8: the ledger account each step code posts to. */
export const STEP_ACCOUNTS = {
  korea_vat: "vat_korea_payable",
  bd_vat: "vat_bd_payable",
  processing_fee: "processing_fee_income",
  markup: "markup_income",
} as const;

/** A step as it may arrive from JSON: nothing about its shape is trusted. */
type LooseStep = { code?: unknown; rate?: unknown; base?: unknown; label?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

/**
 * The problems of a rule, grouped by condition and, inside one condition, in step order.
 * Empty when the rule is valid. A rule arrives from JSON, so its shape is checked too and a wrong
 * shape gives problems, never a TypeError. The rate check uses parseDecimal, so it cannot disagree
 * with quote.
 */
export function validateRule(rule: PricingRule): string[] {
  if (!isObject(rule)) return ["rule is not an object"];

  const problems: string[] = [];
  if (isBlank(rule.version)) problems.push("version is empty");

  const entries: unknown = rule.steps;
  if (!Array.isArray(entries)) {
    problems.push("steps is not a list");
    return problems;
  }

  const steps: LooseStep[] = [];
  entries.forEach((entry: unknown, i) => {
    if (isObject(entry)) steps.push(entry);
    else problems.push(`step ${i + 1} is not an object`);
  });
  const name = (step: LooseStep): string => String(step.code);

  for (const step of steps) {
    if (typeof step.code !== "string" || !Object.hasOwn(STEP_ACCOUNTS, step.code)) {
      problems.push(`step ${name(step)} has no ledger account`);
    }
  }

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const step of steps) {
    const code = name(step);
    if (seen.has(code) && !repeated.has(code)) {
      repeated.add(code);
      problems.push(`step ${code} appears twice`);
    }
    seen.add(code);
  }

  for (const step of steps) {
    try {
      parseDecimal(step.rate as string, `rate of step ${name(step)}`);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      problems.push(error.message);
    }
  }

  for (const step of steps) {
    if (step.base !== "aws" && step.base !== "subtotal") {
      problems.push(`base of step ${name(step)} must be aws or subtotal`);
    }
  }

  steps.forEach((step, i) => {
    if (step.base === "subtotal" && i !== steps.length - 1) {
      problems.push(`step ${name(step)} has base subtotal and is not the last step`);
    }
  });

  for (const step of steps) {
    const label = isObject(step.label) ? step.label : {};
    if (isBlank(label.bn) || isBlank(label.en)) {
      problems.push(`label of step ${name(step)} must have a Bangla and an English text`);
    }
  }

  return problems;
}
