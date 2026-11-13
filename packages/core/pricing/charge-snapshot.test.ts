import { describe, expect, it } from "vitest";
import {
  CHARGE_SNAPSHOT_VERSION,
  ChargeSnapshotError,
  buildChargeSnapshot,
  chargeSnapshotMatchesInputs,
  parseChargeSnapshot,
  readChargeSnapshot,
  type ChargeInputs,
} from "./charge-snapshot";
import { quoteWithBook, type BookTerms } from "./book";
import type { PricingRule } from "./types";

// WPU-Y2: every charge stores the exact price inputs it used, in one versioned structure.
const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
const BOOK: BookTerms = { margin: { kind: "percent", value: "0.20" }, commission: null };
const FX = {
  id: "0190aaaa-0000-7000-8000-0000000000f1",
  rate: "127",
  effectiveFrom: new Date("2026-11-10T00:00:00.000Z"),
};
const RULE_REF = { id: "0190aaaa-0000-7000-8000-0000000000e1", version: "rule-1" };

function inputs(awsPriceUsd: string, quantity: string, fxRate = "127"): ChargeInputs {
  const booked = quoteWithBook({ awsPriceUsd, quantity, fxRate, rule: RULE }, BOOK);
  return {
    pricedAt: new Date("2026-11-11T08:00:00.000Z"),
    awsPriceUsd,
    quantity,
    fx: { ...FX, rate: fxRate },
    rule: RULE_REF,
    book: BOOK,
    quote: booked.quote,
  };
}

describe("buildChargeSnapshot", () => {
  it("holds the price inputs, the rounding and the BDT amounts as text", () => {
    const s = buildChargeSnapshot("purchase", inputs("5", "1"));
    expect(s.schemaVersion).toBe(CHARGE_SNAPSHOT_VERSION);
    expect(s).toMatchObject({
      kind: "purchase",
      currency: "BDT",
      pricedAt: "2026-11-11T08:00:00.000Z",
      awsPriceUsd: "5",
      quantity: "1",
      fx: { id: FX.id, rate: "127", effectiveFrom: "2026-11-10T00:00:00.000Z" },
      rule: RULE_REF,
      book: BOOK,
      rounding: "half_up",
    });
    expect(typeof s.totalMinor).toBe("string");
    expect(BigInt(s.totalMinor)).toBe(
      BigInt(s.baseMinor) + s.steps.reduce((a, x) => a + BigInt(x.amountMinor), 0n),
    );
    expect(s.meter).toBeUndefined();
  });

  it("survives JSON and parses to the same value", () => {
    const s = buildChargeSnapshot("renewal", inputs("5", "1"));
    expect(parseChargeSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("a metered charge records the usage and the unit price, and its steps add up to the charge", () => {
    const unit = inputs("0.05", "1");
    const s = buildChargeSnapshot("metered", unit, {
      meter: {
        metric: "snapshot_gb",
        usage: "10",
        unitTotalMinor: unit.quote.totalMinor.toString(),
      },
      charge: {
        baseMinor: 100n,
        steps: [{ code: "korea_vat", amountMinor: 10n }],
        totalMinor: 110n,
      },
    });
    expect(s.meter?.usage).toBe("10");
    expect(s.baseMinor).toBe("100");
    expect(s.totalMinor).toBe("110");
    // the base of a metered charge is a share of the unit price: no recomputation claim is made
    expect(chargeSnapshotMatchesInputs(s)).toBe(true);
  });

  it("refuses a fx rate that is not the rate of the quote, and a rule version that is not the quote's", () => {
    const i = inputs("5", "1");
    expect(() => buildChargeSnapshot("purchase", { ...i, fx: { ...i.fx, rate: "128" } })).toThrow(
      ChargeSnapshotError,
    );
    expect(() =>
      buildChargeSnapshot("purchase", { ...i, rule: { ...i.rule, version: "rule-2" } }),
    ).toThrow(ChargeSnapshotError);
  });
});

describe("recomputation with the saved inputs (property)", () => {
  const cases: [string, string, string][] = [
    ["5", "1", "127"],
    ["0.005", "1", "121.37"],
    ["3.50", "2", "119.999"],
    ["0.0035", "1", "133.5"],
    ["12.345678", "3", "109.123456"],
    ["0.00001", "1", "127"],
    ["999.99", "12", "130.5"],
  ];
  for (const [aws, qty, fx] of cases) {
    it(`snapshot base equals recomputation for ${aws} x ${qty} at ${fx}`, () => {
      const s = buildChargeSnapshot("purchase", inputs(aws, qty, fx));
      expect(chargeSnapshotMatchesInputs(s)).toBe(true);
    });
  }

  it("rounds half up: 0.005 USD at 1.00 is 1 paisa when x100 is 0.5, 0.004 is 0", () => {
    const up = buildChargeSnapshot("purchase", inputs("0.005", "1", "1"));
    expect(up.baseMinor).toBe("1");
    const down = buildChargeSnapshot("purchase", inputs("0.004", "1", "1"));
    expect(down.baseMinor).toBe("0");
  });

  it("a tampered base no longer matches the inputs", () => {
    const s = buildChargeSnapshot("purchase", inputs("5", "1"));
    const bad = {
      ...s,
      baseMinor: "63501",
      totalMinor: String(BigInt(s.totalMinor) + 1n),
    };
    expect(chargeSnapshotMatchesInputs(bad)).toBe(false);
  });
});

describe("parseChargeSnapshot", () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(buildChargeSnapshot("purchase", inputs("5", "1"))));
  it("refuses a number where text is required (no floats)", () => {
    const j = good();
    j.baseMinor = 63500;
    expect(() => parseChargeSnapshot(j)).toThrow(ChargeSnapshotError);
  });
  it("refuses an unknown field, a bad total and another currency", () => {
    expect(() => parseChargeSnapshot({ ...good(), extra: 1 })).toThrow(ChargeSnapshotError);
    expect(() => parseChargeSnapshot({ ...good(), totalMinor: "1" })).toThrow(ChargeSnapshotError);
    expect(() => parseChargeSnapshot({ ...good(), currency: "USD" })).toThrow(ChargeSnapshotError);
  });
  it("a later schema version is not read as version 1 (fails closed)", () => {
    expect(readChargeSnapshot({ ...good(), schemaVersion: 2 })).toEqual({
      state: "unsupported",
      version: 2,
    });
  });
});

describe("readChargeSnapshot (legacy)", () => {
  it("null, undefined and an empty object are legacy: nothing is recalculated", () => {
    expect(readChargeSnapshot(null)).toEqual({ state: "legacy" });
    expect(readChargeSnapshot(undefined)).toEqual({ state: "legacy" });
    expect(readChargeSnapshot({})).toEqual({ state: "legacy" });
  });
  it("a damaged snapshot is invalid, never legacy and never repaired", () => {
    expect(readChargeSnapshot({ schemaVersion: 1, kind: "purchase" }).state).toBe("invalid");
    expect(readChargeSnapshot("x").state).toBe("invalid");
  });
  it("a good snapshot is read", () => {
    const s = buildChargeSnapshot("purchase", inputs("5", "1"));
    expect(readChargeSnapshot(JSON.parse(JSON.stringify(s)))).toEqual({
      state: "snapshot",
      value: s,
    });
  });
});
