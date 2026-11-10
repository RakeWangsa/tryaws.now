import { expect, it } from "vitest";
import type { PricingRule, PricingStep } from "./types";
import { STEP_ACCOUNTS, accountFor, isPricingRule, validateRule } from "./validate";

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
  expect(problems[0]!.message.startsWith(message)).toBe(true);
});

it("reports every problem of a rule, in order", () => {
  const rule = launch();
  rule.version = "";
  rule.steps[1]!.base = "subtotal";
  expect(validateRule(rule).map((p) => p.message.split(" ").slice(0, 2).join(" "))).toEqual([
    "version is",
    "step bd_vat",
  ]);
});

it("reports a repeated code once, however often it repeats", () => {
  const rule = launch();
  rule.steps.push(step("markup", "0.01"), step("markup", "0.02"));
  expect(
    validateRule(rule).filter((p) => p.message.startsWith("step markup appears twice")),
  ).toHaveLength(1);
});

const bad = (rule: unknown): PricingRule => rule as PricingRule;

it("reports a rule that is not an object", () => {
  expect(validateRule(bad(null))).toEqual([{ path: "", message: "rule is not an object" }]);
  expect(validateRule(bad("x"))).toEqual([{ path: "", message: "rule is not an object" }]);
});

it.each<[string, unknown]>([
  ["no steps", { version: "v" }],
  ["null steps", { version: "v", steps: null }],
  ["object steps", { version: "v", steps: {} }],
])("reports %s as not a list", (_, rule) => {
  const problems = validateRule(bad(rule));
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message.startsWith("steps is not a list")).toBe(true);
});

it("reports a missing version before a missing list", () => {
  const problems = validateRule(bad({}));
  expect(problems).toHaveLength(2);
  expect(problems[0]!.message.startsWith("version is empty")).toBe(true);
  expect(problems[1]!.message.startsWith("steps is not a list")).toBe(true);
});

it("reports a null entry of the steps", () => {
  const rule = launch();
  (rule.steps as unknown[]).push(null);
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message.startsWith("step 5 is not an object")).toBe(true);
});

it.each<[string, unknown]>([
  ["no label", undefined],
  ["no bn", { en: "a" }],
  ["no en", { bn: "ক" }],
])("reports a step with %s", (_, value) => {
  const rule = launch();
  (rule.steps[0] as unknown as { label: unknown }).label = value;
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message.startsWith("label of step korea_vat")).toBe(true);
});

it("reports a rate given as a number", () => {
  const rule = launch();
  (rule.steps[0] as unknown as { rate: unknown }).rate = 0.1;
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message.startsWith("rate of step korea_vat")).toBe(true);
});

it.each(["toString", "constructor"])("reports the code %s as having no account", (code) => {
  const rule = launch();
  rule.steps.push(step(code, "0.01"));
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message.startsWith(`step ${code} has no ledger account`)).toBe(true);
});

it("reports all seven conditions in order and keeps checking a code with no account", () => {
  const rule = bad({
    version: " ",
    steps: [
      { code: "handling", rate: "x", base: "total", label: { bn: "", en: "a" } },
      step("markup", "0"),
      step("markup", "0"),
    ],
  });
  const problems = validateRule(rule);
  const wanted = [
    "version is empty",
    "step handling has no ledger account",
    "step markup appears twice",
    "rate of step handling",
    "base of step handling",
    "label of step handling",
  ];
  expect(problems).toHaveLength(6);
  wanted.forEach((start, i) => expect(problems[i]!.message.startsWith(start)).toBe(true));
});

it.each<[string, (rule: PricingRule) => void, string]>([
  [
    "an empty version",
    (r) => {
      r.version = "";
    },
    "version",
  ],
  [
    "no steps",
    (r) => {
      delete (r as Partial<PricingRule>).steps;
    },
    "steps",
  ],
  [
    "a null fifth entry",
    (r) => {
      (r.steps as unknown[]).push(null);
    },
    "steps[4]",
  ],
  [
    "a code with no account",
    (r) => {
      r.steps.push(step("handling", "0.01"));
    },
    "steps[4].code",
  ],
  [
    "a repeated code",
    (r) => {
      r.steps.push(step("markup", "0.01"));
    },
    "steps[4].code",
  ],
  [
    "a rate that is not a number",
    (r) => {
      r.steps[0]!.rate = "10%";
    },
    "steps[0].rate",
  ],
  [
    "an unknown base",
    (r) => {
      (r.steps[0] as { base: string }).base = "total";
    },
    "steps[0].base",
  ],
  [
    "subtotal before the end",
    (r) => {
      r.steps[1]!.base = "subtotal";
    },
    "steps[1].base",
  ],
  [
    "a missing English label",
    (r) => {
      r.steps[2]!.label = { bn: "ক", en: " " };
    },
    "steps[2].label",
  ],
])("reports the path of %s", (_, change, path) => {
  const rule = launch();
  change(rule);
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.path).toBe(path);
});

it("counts step indexes in the array as given, also after an entry that is not an object", () => {
  const rule = launch();
  (rule.steps as unknown[]).unshift(null);
  expect(validateRule(rule)).toEqual([{ path: "steps[0]", message: "step 1 is not an object" }]);

  rule.steps[2]!.base = "subtotal";
  const problems = validateRule(rule);
  expect(problems).toHaveLength(2);
  expect(problems).toContainEqual({
    path: "steps[2].base",
    message: "step bd_vat has base subtotal and is not the last step",
  });
});

it("treats an array as not an object", () => {
  expect(validateRule([])).toEqual([{ path: "", message: "rule is not an object" }]);
  const rule = launch();
  (rule.steps as unknown[]).push([]);
  const problems = validateRule(rule);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toBe("step 5 is not an object");
});

it.each(["c".repeat(100), "a\nb"])(
  "keeps the message of the code %j short and on one line",
  (code) => {
    const rule = launch();
    rule.steps.push(step(code, "0.01"));
    const problems = validateRule(rule);
    expect(problems.length).toBeGreaterThan(0);
    for (const { message } of problems) {
      expect(message.length).toBeLessThan(120);
      expect(message).not.toMatch(/[\r\n]/);
    }
  },
);

it("isPricingRule is true only for a rule without problems", () => {
  expect(isPricingRule(launch())).toBe(true);
  expect(isPricingRule({ version: "v" })).toBe(false);
});

it("freezes the account table and looks a code up only among the step codes", () => {
  expect(Object.isFrozen(STEP_ACCOUNTS)).toBe(true);
  expect(accountFor("bd_vat")).toBe("vat_bd_payable");
  expect(accountFor("toString")).toBeUndefined();
  expect(accountFor("constructor")).toBeUndefined();
  expect(accountFor("handling")).toBeUndefined();
});
