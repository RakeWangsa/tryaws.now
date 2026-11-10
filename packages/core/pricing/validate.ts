import { parseDecimal } from "./decimal";
import { PricingInputError, type PricingProblem } from "./errors";
import type { PricingRule } from "./types";

/** Spec section 8: the ledger account each step code posts to. */
export const STEP_ACCOUNTS = Object.freeze({
  korea_vat: "vat_korea_payable",
  bd_vat: "vat_bd_payable",
  processing_fee: "processing_fee_income",
  markup: "markup_income",
} as const);

export type StepCode = keyof typeof STEP_ACCOUNTS;

/** The ledger account of a step code; undefined for any other text, "toString" included. */
export function accountFor(code: string): (typeof STEP_ACCOUNTS)[StepCode] | undefined {
  return Object.hasOwn(STEP_ACCOUNTS, code) ? STEP_ACCOUNTS[code as StepCode] : undefined;
}

/** A step as it may arrive from JSON: nothing about its shape is trusted. */
type LooseStep = { code?: unknown; rate?: unknown; base?: unknown; label?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

/** The full text of a code, used to find repeats. Never throws, even for an object without a prototype. */
function codeText(code: unknown): string {
  try {
    return String(code);
  } catch {
    return `a value of type ${typeof code}`;
  }
}

/** A code as shown in a message: printable ASCII only, at most 40 characters. */
const shown = (code: unknown): string =>
  codeText(code)
    .replace(/[^ -~]/g, "?")
    .slice(0, 40);

/**
 * The problems of a rule, grouped by condition and, inside one condition, in step order.
 * Empty when the rule is valid. A rule arrives from JSON, so its shape is checked too and a wrong
 * shape gives problems, never a TypeError. The rate check uses parseDecimal, so it cannot disagree
 * with quote. A step index in a path is its index in the steps array as given.
 */
export function validateRule(rule: unknown): PricingProblem[] {
  if (!isObject(rule)) return [{ path: "", message: "rule is not an object" }];

  const problems: PricingProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  if (isBlank(rule.version)) add("version", "version is empty");

  const entries = rule.steps;
  if (!Array.isArray(entries)) {
    add("steps", "steps is not a list");
    return problems;
  }

  const steps: { step: LooseStep; at: string; last: boolean }[] = [];
  entries.forEach((entry: unknown, i) => {
    const at = `steps[${i}]`;
    if (isObject(entry)) steps.push({ step: entry, at, last: i === entries.length - 1 });
    else add(at, `step ${i + 1} is not an object`);
  });

  for (const { step, at } of steps) {
    if (typeof step.code !== "string" || accountFor(step.code) === undefined) {
      add(`${at}.code`, `step ${shown(step.code)} has no ledger account`);
    }
  }

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { step, at } of steps) {
    const code = codeText(step.code);
    if (seen.has(code) && !repeated.has(code)) {
      repeated.add(code);
      add(`${at}.code`, `step ${shown(step.code)} appears twice`);
    }
    seen.add(code);
  }

  for (const { step, at } of steps) {
    try {
      parseDecimal(step.rate, `rate of step ${shown(step.code)}`);
    } catch (error) {
      if (!(error instanceof PricingInputError)) throw error;
      add(`${at}.rate`, error.message);
    }
  }

  for (const { step, at } of steps) {
    if (step.base !== "aws" && step.base !== "subtotal") {
      add(`${at}.base`, `base of step ${shown(step.code)} must be aws or subtotal`);
    }
  }

  for (const { step, at, last } of steps) {
    if (step.base === "subtotal" && !last) {
      add(`${at}.base`, `step ${shown(step.code)} has base subtotal and is not the last step`);
    }
  }

  for (const { step, at } of steps) {
    const label = isObject(step.label) ? step.label : {};
    if (isBlank(label.bn) || isBlank(label.en)) {
      add(
        `${at}.label`,
        `label of step ${shown(step.code)} must have a Bangla and an English text`,
      );
    }
  }

  return problems;
}

/** True when the rule has no problem at all. */
export function isPricingRule(rule: unknown): rule is PricingRule {
  return validateRule(rule).length === 0;
}
