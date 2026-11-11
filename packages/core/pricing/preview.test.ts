import { expect, it } from "vitest";
import { PREVIEW_SAMPLES, previewPricing, problemFields, type PreviewSample } from "./preview";
import { quote } from "./quote";
import type { PricingRule, PricingStep } from "./types";

const label = { bn: "ক", en: "a" };
const step = (code: string, rate: string, base: PricingStep["base"] = "aws"): PricingStep => ({
  code,
  rate,
  base,
  label,
});
const LAUNCH: PricingRule = {
  version: "preview",
  steps: [
    step("korea_vat", "0.10"),
    step("bd_vat", "0.05"),
    step("processing_fee", "0.02"),
    step("markup", "0"),
  ],
};
const ALTERNATIVE: PricingRule = {
  version: "preview",
  steps: [
    step("korea_vat", "0.10"),
    step("processing_fee", "0.02"),
    step("markup", "0"),
    step("bd_vat", "0.05", "subtotal"),
  ],
};
const preview = (input: Parameters<typeof previewPricing>[0]) => {
  const result = previewPricing(input);
  if (!result.ok) throw new Error("preview refused: " + JSON.stringify(result));
  return result.value.rows;
};
const parts = (q: ReturnType<typeof quote>) => [
  q.baseMinor,
  ...q.steps.map((s) => s.amountMinor),
  q.totalMinor,
];

it("there are five samples, with these keys and prices", () => {
  expect(PREVIEW_SAMPLES.map((s) => [s.id, s.family, s.awsPriceUsd, s.quantity ?? null])).toEqual([
    ["instance_5", "linux_instance", "5", null],
    ["instance_24", "linux_instance", "24", null],
    ["instance_84", "linux_instance", "84", null],
    ["disk_80gb", "disk", "0.10", "80"],
    ["backup_1gb_day", "backup", "0.05", "0.0333333333"],
  ]);
  expect(Object.isFrozen(PREVIEW_SAMPLES)).toBe(true);
});

it("at FX 127 and the launch rule the three plans give the section 8 vectors and the other two the engine's amounts", () => {
  expect(
    preview({ candidate: { fxRate: "127", rule: LAUNCH } }).map((r) => parts(r.candidate)),
  ).toEqual([
    [63500n, 6350n, 3175n, 1270n, 0n, 74295n],
    [304800n, 30480n, 15240n, 6096n, 0n, 356616n],
    [1066800n, 106680n, 53340n, 21336n, 0n, 1248156n],
    [101600n, 10160n, 5080n, 2032n, 0n, 118872n],
    [21n, 2n, 1n, 0n, 0n, 24n],
  ]);
});

it("each row is exactly what quote() answers for the same input (preview equals engine output)", () => {
  for (const [fxRate, rule] of [
    ["127", LAUNCH],
    ["124.77", LAUNCH],
    ["127", ALTERNATIVE],
    ["131.5", ALTERNATIVE],
  ] as const) {
    const rows = preview({ candidate: { fxRate, rule } });
    expect(rows).toHaveLength(5);
    rows.forEach((row, i) => {
      const s = PREVIEW_SAMPLES[i]!;
      expect(row.sampleId).toBe(s.id);
      expect(row.candidate).toEqual(
        quote({ awsPriceUsd: s.awsPriceUsd, quantity: s.quantity, fxRate, rule }),
      );
    });
  }
});

it("the alternative rule and FX 124.77 give the extra vectors of section 8 for the 5 USD plan", () => {
  expect(
    preview({ candidate: { fxRate: "127", rule: ALTERNATIVE } })[0]!.candidate.totalMinor,
  ).toBe(74676n);
  expect(preview({ candidate: { fxRate: "124.77", rule: LAUNCH } })[0]!.candidate.totalMinor).toBe(
    72991n,
  );
});

it("a current basis adds its quotes and the change of each total", () => {
  const rows = preview({
    candidate: { fxRate: "130", rule: LAUNCH },
    current: { fxRate: "127", rule: LAUNCH },
  });
  expect([
    rows[0]!.candidate.totalMinor,
    rows[0]!.current!.totalMinor,
    rows[0]!.deltaMinor,
  ]).toEqual([76050n, 74295n, 1755n]);
  for (const r of rows) expect(r.deltaMinor).toBe(r.candidate.totalMinor - r.current!.totalMinor);
  expect([rows[3]!.quantity, rows[0]!.quantity]).toEqual(["80", "1"]);
  const alone = preview({ candidate: { fxRate: "127", rule: LAUNCH }, current: null })[0]!;
  expect([alone.current, alone.deltaMinor]).toEqual([null, null]);
});

it("a rule the engine refuses is a validation failure that names the step, and nothing is previewed", () => {
  const negative: PricingRule = {
    version: "preview",
    steps: [
      step("korea_vat", "0.10"),
      step("bd_vat", "0.05", "subtotal"),
      step("processing_fee", "0.02"),
      step("markup", "0"),
    ],
  };
  expect(previewPricing({ candidate: { fxRate: "127", rule: negative } })).toEqual({
    ok: false,
    error: "validation",
    fields: { "steps[1].base": "step bd_vat has base subtotal and is not the last step" },
  });
  const noAccount: PricingRule = { version: "preview", steps: [step("handling", "0.01")] };
  expect(previewPricing({ candidate: { fxRate: "127", rule: noAccount } })).toMatchObject({
    ok: false,
    error: "validation",
    fields: { "steps[0].code": "step handling has no ledger account" },
  });
});

it("a rate that is not plain decimal text above 0 is a validation failure on fxRate", () => {
  for (const fxRate of ["abc", "0", "", "1e2", "-5"]) {
    expect(previewPricing({ candidate: { fxRate, rule: LAUNCH } })).toEqual({
      ok: false,
      error: "validation",
      fields: { fxRate: "fxRate must be plain decimal text above 0" },
    });
  }
});

it("a rule is checked even when there are no samples", () => {
  const bad: PricingRule = { version: " ", steps: [] };
  expect(previewPricing({ candidate: { fxRate: "127", rule: bad }, samples: [] })).toMatchObject({
    ok: false,
    error: "validation",
    fields: { version: "version is empty" },
  });
  expect(preview({ candidate: { fxRate: "127", rule: LAUNCH }, samples: [] })).toEqual([]);
});

it("other samples can be given, and a sample the engine refuses is named by its key", () => {
  const custom: PreviewSample[] = [{ id: "bucket_250gb", family: "bucket", awsPriceUsd: "5" }];
  expect(
    preview({ candidate: { fxRate: "127", rule: LAUNCH }, samples: custom })[0]!.candidate
      .totalMinor,
  ).toBe(74295n);
  const result = previewPricing({
    candidate: { fxRate: "127", rule: LAUNCH },
    samples: [{ id: "broken", family: "bucket", awsPriceUsd: "x" }],
  });
  expect(result).toMatchObject({ ok: false, error: "validation" });
  expect(Object.keys((result as { fields: Record<string, string> }).fields)).toEqual([
    "broken.awsPriceUsd",
  ]);
});

it("problemFields: the empty path is rule, two messages of one path are joined, a prefix goes in front", () => {
  expect(problemFields([{ path: "", message: "a" }])).toEqual({ rule: "a" });
  expect(
    problemFields([
      { path: "steps[1].code", message: "a" },
      { path: "steps[1].code", message: "b" },
    ]),
  ).toEqual({ "steps[1].code": "a; b" });
  expect(problemFields([{ path: "awsPriceUsd", message: "m" }], "broken.")).toEqual({
    "broken.awsPriceUsd": "m",
  });
});

it("a current basis the engine refuses is an internal failure, never a preview of half the data", () => {
  const bad: PricingRule = { version: "x", steps: [step("handling", "0.01")] };
  expect(
    previewPricing({
      candidate: { fxRate: "127", rule: LAUNCH },
      current: { fxRate: "127", rule: bad },
    }),
  ).toEqual({
    ok: false,
    error: "internal",
  });
});
