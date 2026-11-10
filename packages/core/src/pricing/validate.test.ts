import { expect, it } from "vitest";
import type { PricingRule, PricingStep } from "./types";
import { STEP_ACCOUNTS, validateRule } from "./validate";

const label = { bn: "ক", en: "a" };
const step = (code: string, rate: string, base: PricingStep["base"] = "aws"): PricingStep => ({
  code,
  rate,
  base,
  label,
});
const launch = (): PricingRule => ({
  version: "bd-1",
  steps: [
    step("korea_vat", "0.10"),
    step("bd_vat", "0.05"),
    step("processing_fee", "0.02"),
    step("markup", "0"),
  ],
});

it("maps every launch step to its ledger account", () => {
  expect(STEP_ACCOUNTS).toEqual({
    korea_vat: "vat_korea_payable",
    bd_vat: "vat_bd_payable",
    processing_fee: "processing_fee_income",
    markup: "markup_income",
  });
});

it("accepts the launch rule, the alternative rule and a rule with no step", () => {
  expect(validateRule(launch())).toEqual([]);
  const alternative = launch();
  alternative.steps = [
    alternative.steps[0]!,
    alternative.steps[2]!,
    alternative.steps[3]!,
    step("bd_vat", "0.05", "subtotal"),
  ];
  expect(validateRule(alternative)).toEqual([]);
  expect(validateRule({ version: "v", steps: [] })).toEqual([]);
});

it.each<[string, (rule: PricingRule) => void, string]>([
  [
    "an empty version",
    (r) => {
      r.version = "  ";
    },
    "version is empty",
  ],
  [
    "a code with no account",
    (r) => {
      r.steps.push(step("handling", "0.01"));
    },
    "step handling has no ledger account",
  ],
  [
    "a repeated code",
    (r) => {
      r.steps.push(step("markup", "0.01"));
    },
    "step markup appears twice",
  ],
  [
    "a rate that is not a number",
    (r) => {
      r.steps[0]!.rate = "10%";
    },
    "rate of step korea_vat",
  ],
  [
    "a negative rate",
    (r) => {
      r.steps[0]!.rate = "-0.10";
    },
    "rate of step korea_vat",
  ],
  [
    "an unknown base",
    (r) => {
      (r.steps[0] as { base: string }).base = "total";
    },
    "base of step korea_vat",
  ],
  [
    "subtotal before the end",
    (r) => {
      r.steps[1]!.base = "subtotal";
    },
    "step bd_vat has base subtotal and is not the last step",
  ],
  [
    "a missing English label",
    (r) => {
      r.steps[2]!.label = { bn: "ক", en: " " };
    },
    "label of step processing_fee",
  ],
])("reports %s", (_, change, message) => {
  const rule = launch();
  change(rule);
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.startsWith(message)).toBe(true);
});

it("reports every problem of a rule, in order", () => {
  const rule = launch();
  rule.version = "";
  rule.steps[1]!.base = "subtotal";
  expect(validateRule(rule).map((p) => p.split(" ").slice(0, 2).join(" "))).toEqual([
    "version is",
    "step bd_vat",
  ]);
});

it("reports a repeated code once, however often it repeats", () => {
  const rule = launch();
  rule.steps.push(step("markup", "0.01"), step("markup", "0.02"));
  expect(validateRule(rule).filter((p) => p.startsWith("step markup appears twice"))).toHaveLength(
    1,
  );
});
