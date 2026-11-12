import { describe, expect, it } from "vitest";
import {
  BOOK_MAX_COMMISSION_PERCENT,
  BOOK_MAX_MARGIN_PERCENT,
  isBookTerms,
  quoteWithBook,
  validateBookTerms,
  type BookTerms,
} from "./book";
import { PricingInputError } from "./errors";
import { quote } from "./quote";
import type { PricingRule } from "./types";

const label = { bn: "ক", en: "a" };
// Section 8, launch configuration, markup at 0.
const LAUNCH: PricingRule = {
  version: "bd-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};
// Section 8, the alternative: bd_vat last, on the subtotal.
const ALT: PricingRule = {
  version: "bd-2",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "subtotal", label },
  ],
};
const input = (awsPriceUsd: string, rule = LAUNCH, quantity?: string) => ({
  awsPriceUsd,
  fxRate: "127",
  rule,
  ...(quantity === undefined ? {} : { quantity }),
});
const percent = (value: string) => ({ kind: "percent" as const, value });
const fixed = (value: string) => ({ kind: "fixed" as const, value });

describe("without terms the book is the engine", () => {
  it.each(["5", "7", "12", "24", "44", "84", "9.50", "0.50", "3.50"])("aws %s", (aws) => {
    const booked = quoteWithBook(input(aws), null);
    expect(booked.quote).toEqual(quote(input(aws)));
    expect(booked.marginMinor).toBe(0n);
    expect(booked.commissionMinor).toBe(0n);
  });

  it("a rule with no markup step is still priced without terms", () => {
    const rule: PricingRule = { version: "x", steps: [LAUNCH.steps[0]!] };
    expect(quoteWithBook(input("5", rule), null).quote).toEqual(quote(input("5", rule)));
  });
});

describe("a percent margin is the rate of the markup step", () => {
  it("10 percent of the base: 5 USD at FX 127", () => {
    const booked = quoteWithBook(input("5"), { margin: percent("0.10"), commission: null });
    expect(booked.marginMinor).toBe(6350n);
    expect(booked.quote.steps.find((s) => s.code === "markup")?.amountMinor).toBe(6350n);
    // 74295 (section 8) plus the margin
    expect(booked.quote.totalMinor).toBe(74295n + 6350n);
  });

  it("is quote() of the rule with that markup rate (preview equals engine)", () => {
    const rule: PricingRule = {
      ...LAUNCH,
      steps: LAUNCH.steps.map((s) => (s.code === "markup" ? { ...s, rate: "0.1234" } : s)),
    };
    for (const aws of ["5", "9.50", "0.50", "84"]) {
      const booked = quoteWithBook(input(aws), { margin: percent("0.1234"), commission: null });
      expect(booked.quote).toEqual({ ...quote(input(aws, rule)), ruleVersion: "bd-1" });
    }
  });

  it("replaces a markup rate that the rule has", () => {
    const rule: PricingRule = {
      ...LAUNCH,
      steps: LAUNCH.steps.map((s) => (s.code === "markup" ? { ...s, rate: "0.30" } : s)),
    };
    const booked = quoteWithBook(input("5", rule), { margin: percent("0.10"), commission: null });
    expect(booked.marginMinor).toBe(6350n);
  });

  it("rounds half up: 127 paisa at 50 percent is 64", () => {
    const booked = quoteWithBook(input("0.01"), { margin: percent("0.5"), commission: null });
    expect(booked.quote.baseMinor).toBe(127n);
    expect(booked.marginMinor).toBe(64n);
  });
});

describe("a fixed margin is paisa for each unit and enters the markup step", () => {
  it("500 paisa on a server", () => {
    const booked = quoteWithBook(input("5"), { margin: fixed("500"), commission: null });
    expect(booked.marginMinor).toBe(500n);
    expect(booked.quote.totalMinor).toBe(74295n + 500n);
  });

  it("5 paisa for each of 80 GB is 400", () => {
    const booked = quoteWithBook(input("0.10", LAUNCH, "80"), {
      margin: fixed("5"),
      commission: null,
    });
    expect(booked.quote.baseMinor).toBe(101600n);
    expect(booked.marginMinor).toBe(400n);
  });

  it("a fractional quantity is rounded half up: 5 paisa for 0.1 unit is 1 (0.5 rounds up)", () => {
    const booked = quoteWithBook(input("1", LAUNCH, "0.1"), {
      margin: fixed("5"),
      commission: null,
    });
    expect(booked.marginMinor).toBe(1n);
  });

  it("is in the running total that a subtotal step sees (section 8 alternative)", () => {
    const booked = quoteWithBook(input("5", ALT), { margin: fixed("500"), commission: null });
    // 63500 + 6350 + 1270 + 500 = 71620; 5 percent of it is 3581
    expect(booked.quote.steps.find((s) => s.code === "bd_vat")?.amountMinor).toBe(3581n);
    expect(booked.quote.totalMinor).toBe(75201n);
  });

  it("a fixed margin of 0 changes nothing", () => {
    const booked = quoteWithBook(input("5"), { margin: fixed("0"), commission: null });
    expect(booked.quote).toEqual(quote(input("5")));
  });
});

describe("the commission is a share of the margin and never more than the margin", () => {
  const margin = percent("0.10"); // 6350 on 5 USD
  it("a percent of the margin", () => {
    const booked = quoteWithBook(input("5"), { margin, commission: percent("0.20") });
    expect(booked.commissionMinor).toBe(1270n);
  });
  it("rounds half up", () => {
    // margin 5 paisa, 10 percent of it is 0.5 and rounds up to 1; 9 percent is 0.45 and rounds to 0
    const half = quoteWithBook(input("5"), { margin: fixed("5"), commission: percent("0.1") });
    expect(half.commissionMinor).toBe(1n);
    const below = quoteWithBook(input("5"), { margin: fixed("5"), commission: percent("0.09") });
    expect(below.commissionMinor).toBe(0n);
  });
  it("paisa for each unit", () => {
    const booked = quoteWithBook(input("0.10", LAUNCH, "80"), {
      margin: fixed("5"),
      commission: fixed("2"),
    });
    expect(booked.commissionMinor).toBe(160n);
  });
  it("is capped at the margin", () => {
    const booked = quoteWithBook(input("5"), { margin: fixed("500"), commission: fixed("99999") });
    expect(booked.commissionMinor).toBe(500n);
  });
  it("is 0 when there is no margin", () => {
    const booked = quoteWithBook(input("5"), { margin: fixed("0"), commission: percent("0.5") });
    expect(booked.commissionMinor).toBe(0n);
  });
  it("does not change what the customer pays", () => {
    const without = quoteWithBook(input("5"), { margin, commission: null });
    const withIt = quoteWithBook(input("5"), { margin, commission: percent("0.5") });
    expect(withIt.quote).toEqual(without.quote);
  });
});

describe("terms the engine refuses", () => {
  const terms = (margin: unknown, commission: unknown = null) => ({ margin, commission });

  it("a rule without a markup step cannot carry a margin", () => {
    const rule: PricingRule = { version: "x", steps: [LAUNCH.steps[0]!] };
    expect(() => quoteWithBook(input("5", rule), { margin: fixed("5"), commission: null })).toThrow(
      PricingInputError,
    );
    expect(() =>
      quoteWithBook(input("5", rule), { margin: percent("0.1"), commission: null }),
    ).toThrow(PricingInputError);
  });

  it.each([
    ["a number", terms({ kind: "percent", value: 0.1 })],
    ["a negative percent", terms(percent("-0.1"))],
    ["an exponent", terms(percent("1e-1"))],
    ["more than the cap", terms(percent("5.0001"))],
    ["five decimals", terms(percent("0.12345"))],
    ["a fixed with a fraction", terms(fixed("1.5"))],
    ["a fixed that is huge", terms(fixed("1000000000"))],
    ["an unknown kind", terms({ kind: "pct", value: "1" })],
    ["no margin", terms(undefined)],
    ["a commission above 100 percent", terms(percent("0.1"), percent("1.01"))],
    ["a commission of the wrong kind", terms(percent("0.1"), { kind: "x", value: "1" })],
    ["an array", []],
  ])("%s", (_name, bad) => {
    expect(validateBookTerms(bad).length).toBeGreaterThan(0);
    expect(isBookTerms(bad)).toBe(false);
    expect(() => quoteWithBook(input("5"), bad as BookTerms)).toThrow(PricingInputError);
  });

  it.each([
    terms(percent("0")),
    terms(percent("5"), percent("1")),
    terms(percent("0.1500")),
    terms(fixed("0")),
    terms(fixed("999999999"), fixed("0")),
  ])("accepts %j", (good) => {
    expect(validateBookTerms(good)).toEqual([]);
    expect(isBookTerms(good)).toBe(true);
  });

  it("states the caps", () => {
    expect(BOOK_MAX_MARGIN_PERCENT).toBe("5");
    expect(BOOK_MAX_COMMISSION_PERCENT).toBe("1");
  });
});
