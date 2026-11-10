import Big from "big.js";
import { expect, it } from "vitest";
import { PricingInputError } from "./errors";
import { quote } from "./quote";
import type { PricingRule, PricingStep } from "./types";

const label = { bn: "ক", en: "a" };

// spec section 8 through verify/baseline.json: the facts the plan states, so a corrected
// vector in the plan changes this test too.
interface Vector {
  aws_usd: string;
  base: number;
  korea_vat: number;
  bd_vat: number;
  processing_fee: number;
  total: number;
}
interface Pricing {
  fx: string;
  steps: Omit<PricingStep, "label">[];
  vectors: Vector[];
  extra: [Vector & { fx: string }, { fx: string; aws_usd: string; bd_vat: number; total: number }];
}
const baselineUrl = new URL("../../../verify/baseline.json", import.meta.url);
const { default: baseline } = (await import(baselineUrl.href, { with: { type: "json" } })) as {
  default: { pricing: Pricing };
};
const { fx, vectors, extra } = baseline.pricing;

const LAUNCH: PricingRule = {
  version: "bd-1",
  steps: baseline.pricing.steps.map((step) => ({ ...step, label })),
};

it("the baseline holds the 14 vectors and the 4 steps of section 8", () => {
  expect(vectors).toHaveLength(14);
  expect(LAUNCH.steps).toHaveLength(4);
});

it.each(vectors)("section 8 vector: $aws_usd USD", (v) => {
  expect(quote({ awsPriceUsd: v.aws_usd, fxRate: fx, rule: LAUNCH })).toEqual({
    currency: "BDT",
    fxRate: fx,
    ruleVersion: "bd-1",
    baseMinor: BigInt(v.base),
    steps: [
      { code: "korea_vat", amountMinor: BigInt(v.korea_vat) },
      { code: "bd_vat", amountMinor: BigInt(v.bd_vat) },
      { code: "processing_fee", amountMinor: BigInt(v.processing_fee) },
      { code: "markup", amountMinor: 0n },
    ],
    totalMinor: BigInt(v.total),
  });
});

it("section 8 extra vector: FX 124.77", () => {
  const v = extra[0];
  const q = quote({ awsPriceUsd: v.aws_usd, fxRate: v.fx, rule: LAUNCH });
  expect([q.baseMinor, ...q.steps.map((s) => s.amountMinor), q.totalMinor]).toEqual([
    BigInt(v.base),
    BigInt(v.korea_vat),
    BigInt(v.bd_vat),
    BigInt(v.processing_fee),
    0n,
    BigInt(v.total),
  ]);
  expect(q.fxRate).toBe(v.fx);
});

it("section 8 extra vector: bd_vat last, on the subtotal", () => {
  const v = extra[1];
  // the steps before bd_vat are on the AWS price, as in the launch vector of the same price
  const launch = vectors.find((row) => row.aws_usd === v.aws_usd)!;
  const rule: PricingRule = {
    version: "bd-2",
    steps: [
      LAUNCH.steps[0]!,
      LAUNCH.steps[2]!,
      LAUNCH.steps[3]!,
      { ...LAUNCH.steps[1]!, base: "subtotal" },
    ],
  };
  const q = quote({ awsPriceUsd: v.aws_usd, fxRate: v.fx, rule });
  expect(q.steps.map((s) => [s.code, s.amountMinor])).toEqual([
    ["korea_vat", BigInt(launch.korea_vat)],
    ["processing_fee", BigInt(launch.processing_fee)],
    ["markup", 0n],
    ["bd_vat", BigInt(v.bd_vat)],
  ]);
  expect(q.totalMinor).toBe(BigInt(v.total));
});

it("the total is the base plus every step", () => {
  for (const { aws_usd: usd } of vectors) {
    const q = quote({ awsPriceUsd: usd, fxRate: "124.77", rule: LAUNCH });
    expect(q.steps.reduce((sum, s) => sum + s.amountMinor, q.baseMinor)).toBe(q.totalMinor);
  }
});

it("rounds half a paisa up where floating point would round down", () => {
  // 1.005 * 100 is 100.5 in decimal and 100.49999999999999 in binary floating point
  const q = quote({ awsPriceUsd: "1.005", fxRate: "1", rule: { version: "v", steps: [] } });
  expect(q).toEqual({
    currency: "BDT",
    fxRate: "1",
    ruleVersion: "v",
    baseMinor: 101n,
    steps: [],
    totalMinor: 101n,
  });
});

it("multiplies by the quantity before converting", () => {
  // block storage: 80 GB at 0.10 USD per GB
  expect(
    quote({ awsPriceUsd: "0.10", quantity: "80", fxRate: "127", rule: LAUNCH }).totalMinor,
  ).toBe(118872n);
  // one GB of backup for one day: 0.05 USD per GB-month, one thirtieth of a month
  const day = quote({ awsPriceUsd: "0.05", quantity: "0.0333333333", fxRate: "127", rule: LAUNCH });
  expect([day.baseMinor, ...day.steps.map((s) => s.amountMinor), day.totalMinor]).toEqual([
    21n,
    2n,
    1n,
    0n,
    0n,
    24n,
  ]);
});

it.each([
  ["awsPriceUsd", { awsPriceUsd: "abc", fxRate: "127" }],
  ["awsPriceUsd", { awsPriceUsd: "-5", fxRate: "127" }],
  ["fxRate", { awsPriceUsd: "5", fxRate: "1e2" }],
  ["fxRate", { awsPriceUsd: "5", fxRate: "" }],
  ["quantity", { awsPriceUsd: "5", fxRate: "127", quantity: "NaN" }],
])("refuses a bad %s", (field, input) => {
  expect(() => quote({ ...input, rule: LAUNCH })).toThrow(RangeError);
  expect(() => quote({ ...input, rule: LAUNCH })).toThrow(new RegExp(field));
});

it("refuses the rule of the negative vector instead of pricing it", () => {
  // spec section 8: bd_vat switched to subtotal but left in second place would give 3493 and 74613
  const rule: PricingRule = {
    version: "bd-3",
    steps: [
      LAUNCH.steps[0]!,
      { ...LAUNCH.steps[1]!, base: "subtotal" },
      LAUNCH.steps[2]!,
      LAUNCH.steps[3]!,
    ],
  };
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(RangeError);
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(
    /invalid pricing rule: step bd_vat has base subtotal/,
  );
});

it("refuses a bad step rate and names the step", () => {
  const rule: PricingRule = {
    version: "bd-1",
    steps: LAUNCH.steps.map((s) => (s.code === "korea_vat" ? { ...s, rate: "10%" } : s)),
  };
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(RangeError);
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(
    /invalid pricing rule: rate of step korea_vat/,
  );
});

it("prices a rate above 1", () => {
  const rule: PricingRule = {
    version: "v",
    steps: [{ code: "markup", rate: "1.5", base: "aws", label }],
  };
  const result = quote({ awsPriceUsd: "5", fxRate: "127", rule });
  expect(result.baseMinor).toBe(63500n);
  expect(result.steps).toEqual([{ code: "markup", amountMinor: 95250n }]);
  expect(result.totalMinor).toBe(158750n);
});

it("refuses a rule without steps instead of crashing", () => {
  const rule = { version: "v" } as unknown as PricingRule;
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(RangeError);
  expect(() => quote({ awsPriceUsd: "5", fxRate: "127", rule })).toThrow(
    /invalid pricing rule: steps is not a list/,
  );
});

it("keeps every digit of an amount beyond 2^53", () => {
  const result = quote({
    awsPriceUsd: "123456789012345678901234567890",
    fxRate: "1",
    rule: { version: "v", steps: [] },
  });
  expect(result.baseMinor).toBe(12345678901234567890123456789000n);
  expect(result.totalMinor).toBe(12345678901234567890123456789000n);
});

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

it.each(["0", "0.000"])("refuses the FX rate %j", (fxRate) => {
  const run = () => quote({ awsPriceUsd: "5", fxRate, rule: LAUNCH });
  expect(run).toThrow(PricingInputError);
  expect(run).toThrow(/fxRate must be greater than 0/);
  expect((thrown(run) as PricingInputError).problems).toEqual([
    { path: "fxRate", message: "fxRate must be greater than 0" },
  ]);
});

it("prices an AWS price of 0 as 0", () => {
  const q = quote({ awsPriceUsd: "0", fxRate: "127", rule: LAUNCH });
  expect(q.baseMinor).toBe(0n);
  expect(q.steps.map((s) => s.amountMinor)).toEqual([0n, 0n, 0n, 0n]);
  expect(q.totalMinor).toBe(0n);
});

it("refuses a quantity of null", () => {
  const run = () =>
    quote({ awsPriceUsd: "5", fxRate: "127", quantity: null as unknown as string, rule: LAUNCH });
  expect(run).toThrow(RangeError);
  expect(run).toThrow(/quantity/);
});

it("refuses the negative vector rule with a typed error and the path of the step", () => {
  const rule: PricingRule = {
    version: "bd-3",
    steps: [
      LAUNCH.steps[0]!,
      { ...LAUNCH.steps[1]!, base: "subtotal" },
      LAUNCH.steps[2]!,
      LAUNCH.steps[3]!,
    ],
  };
  const error = thrown(() => quote({ awsPriceUsd: "5", fxRate: "127", rule }));
  expect(error).toBeInstanceOf(PricingInputError);
  expect(error).toBeInstanceOf(RangeError);
  expect((error as PricingInputError).problems).toEqual([
    {
      path: "steps[1].base",
      message: expect.stringMatching(/^step bd_vat has base subtotal and is not the last step/),
    },
  ]);
});

it("ignores global Big settings set by other code", () => {
  const { RM, DP } = Big;
  try {
    Big.RM = Big.roundDown;
    Big.DP = 0;
    const q = quote({ awsPriceUsd: "9.50", fxRate: "127", rule: LAUNCH });
    expect(q.steps[1]).toEqual({ code: "bd_vat", amountMinor: 6033n });
    expect(q.totalMinor).toBe(141161n);
  } finally {
    Big.RM = RM;
    Big.DP = DP;
  }
});
