import { expect, it } from "vitest";
import { quote } from "./quote";
import type { PricingRule } from "./types";

const label = { bn: "ক", en: "a" };
const LAUNCH: PricingRule = {
  version: "bd-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};

// spec section 8, "Test vectors (FX 127, launch configuration, all amounts in paisa)"
const VECTORS: [string, bigint, bigint, bigint, bigint, bigint][] = [
  ["5", 63500n, 6350n, 3175n, 1270n, 74295n],
  ["7", 88900n, 8890n, 4445n, 1778n, 104013n],
  ["12", 152400n, 15240n, 7620n, 3048n, 178308n],
  ["24", 304800n, 30480n, 15240n, 6096n, 356616n],
  ["44", 558800n, 55880n, 27940n, 11176n, 653796n],
  ["84", 1066800n, 106680n, 53340n, 21336n, 1248156n],
  ["9.50", 120650n, 12065n, 6033n, 2413n, 141161n],
  ["15", 190500n, 19050n, 9525n, 3810n, 222885n],
  ["10", 127000n, 12700n, 6350n, 2540n, 148590n],
  ["18", 228600n, 22860n, 11430n, 4572n, 267462n],
  ["1", 12700n, 1270n, 635n, 254n, 14859n],
  ["2.50", 31750n, 3175n, 1588n, 635n, 37148n],
  ["0.50", 6350n, 635n, 318n, 127n, 7430n],
  ["3.50", 44450n, 4445n, 2223n, 889n, 52007n],
];

it.each(VECTORS)("section 8 vector: %s USD", (usd, base, korea, bd, fee, total) => {
  expect(quote({ awsPriceUsd: usd, fxRate: "127", rule: LAUNCH })).toEqual({
    currency: "BDT",
    fxRate: "127",
    ruleVersion: "bd-1",
    baseMinor: base,
    steps: [
      { code: "korea_vat", amountMinor: korea },
      { code: "bd_vat", amountMinor: bd },
      { code: "processing_fee", amountMinor: fee },
      { code: "markup", amountMinor: 0n },
    ],
    totalMinor: total,
  });
});

it("section 8 extra vector: FX 124.77", () => {
  const q = quote({ awsPriceUsd: "5", fxRate: "124.77", rule: LAUNCH });
  expect([q.baseMinor, ...q.steps.map((s) => s.amountMinor), q.totalMinor]).toEqual([
    62385n,
    6239n,
    3119n,
    1248n,
    0n,
    72991n,
  ]);
  expect(q.fxRate).toBe("124.77");
});

it("section 8 extra vector: bd_vat last, on the subtotal", () => {
  const rule: PricingRule = {
    version: "bd-2",
    steps: [
      LAUNCH.steps[0]!,
      LAUNCH.steps[2]!,
      LAUNCH.steps[3]!,
      { ...LAUNCH.steps[1]!, base: "subtotal" },
    ],
  };
  const q = quote({ awsPriceUsd: "5", fxRate: "127", rule });
  expect(q.steps.map((s) => [s.code, s.amountMinor])).toEqual([
    ["korea_vat", 6350n],
    ["processing_fee", 1270n],
    ["markup", 0n],
    ["bd_vat", 3556n],
  ]);
  expect(q.totalMinor).toBe(74676n);
});

it("the total is the base plus every step", () => {
  for (const [usd] of VECTORS) {
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

it("keeps every digit of an amount beyond 2^53", () => {
  const result = quote({
    awsPriceUsd: "123456789012345678901234567890",
    fxRate: "1",
    rule: { version: "v", steps: [] },
  });
  expect(result.baseMinor).toBe(12345678901234567890123456789000n);
  expect(result.totalMinor).toBe(12345678901234567890123456789000n);
});
