import { describe, expect, it } from "vitest";
import { PricingInputError, quote, quoteWithBook } from "./index";
import { customerUsd, usdMicroText, usdToBdtMinor } from "./usd";
import type { PricingRule } from "./types";

const label = { bn: "ক", en: "a" };
const LAUNCH: PricingRule = {
  version: "launch-1",
  steps: [
    { code: "korea_vat", rate: "0.10", base: "aws", label },
    { code: "bd_vat", rate: "0.05", base: "aws", label },
    { code: "processing_fee", rate: "0.02", base: "aws", label },
    { code: "markup", rate: "0", base: "aws", label },
  ],
};

describe("usdToBdtMinor", () => {
  it("converts micro-USD with the rate, half up, in paisa", () => {
    // 5.85 USD at 127 is 742.95 taka
    expect(usdToBdtMinor(5_850_000n, "127")).toBe(74295n);
    // 1 micro-USD at 127 is 0.0127 paisa: rounds to 0; 40 micro is 0.508 paisa: rounds to 1
    expect(usdToBdtMinor(1n, "127")).toBe(0n);
    expect(usdToBdtMinor(40n, "127")).toBe(1n);
  });

  it("rounds a tie up (half up, never banker's)", () => {
    // 50 micro-USD at 100 is exactly 0.5 paisa
    expect(usdToBdtMinor(50n, "100")).toBe(1n);
    expect(usdToBdtMinor(150n, "100")).toBe(2n);
  });

  it("refuses a number, a negative amount and a rate that is not plain positive decimal text", () => {
    expect(() => usdToBdtMinor(5 as unknown as bigint, "127")).toThrow(TypeError);
    expect(() => usdToBdtMinor(-1n, "127")).toThrow(PricingInputError);
    expect(() => usdToBdtMinor(1n, "0")).toThrow(PricingInputError);
    expect(() => usdToBdtMinor(1n, "1e2")).toThrow(PricingInputError);
    expect(() => usdToBdtMinor(1n, "-3")).toThrow(PricingInputError);
  });
});

describe("customerUsd", () => {
  it("gives the clean dollar price when the engine total is a clean dollar amount (spec vectors at 127)", () => {
    const vectors: [string, bigint, string][] = [
      ["5", 74295n, "5.85"],
      ["7", 104013n, "8.19"],
      ["12", 178308n, "14.04"],
      ["10", 148590n, "11.70"],
      ["0.50", 7430n, "0.585"],
    ];
    for (const [aws, total, usd] of vectors) {
      const q = quote({ awsPriceUsd: aws, fxRate: "127", rule: LAUNCH });
      expect(q.totalMinor).toBe(total);
      const price = customerUsd(q);
      expect(usdMicroText(price.micro)).toBe(usd);
      expect(price.text).toBe(usd);
    }
  });

  it("carries the markup of the price book, in the same total the customer is charged", () => {
    const booked = quoteWithBook(
      { awsPriceUsd: "5", fxRate: "127", rule: LAUNCH },
      { margin: { kind: "percent", value: "0.20" }, commission: null },
    );
    // 5 USD x (1 + 0.17 taxes and fee + 0.20 markup)
    expect(customerUsd(booked.quote).text).toBe("6.85");
    const without = customerUsd(quote({ awsPriceUsd: "5", fxRate: "127", rule: LAUNCH }));
    expect(without.micro < customerUsd(booked.quote).micro).toBe(true);
  });

  it("uses as many decimals as it needs so that the dollars give back the charged paisa exactly", () => {
    const q = quote({ awsPriceUsd: "5", fxRate: "124.77", rule: LAUNCH });
    expect(q.totalMinor).toBe(72991n);
    const price = customerUsd(q);
    expect(usdToBdtMinor(price.micro, q.fxRate)).toBe(72991n);
    expect(price.text.split(".")[1]!.length).toBeGreaterThan(2);
  });

  it("is zero for a zero total", () => {
    expect(customerUsd({ totalMinor: 0n, fxRate: "127" })).toEqual({ micro: 0n, text: "0.00" });
  });

  it("refuses a negative total and a rate that cannot be inverted exactly (fail closed)", () => {
    expect(() => customerUsd({ totalMinor: -1n, fxRate: "127" })).toThrow(PricingInputError);
    expect(() => customerUsd({ totalMinor: 100n, fxRate: "10000" })).toThrow(PricingInputError);
    expect(() => customerUsd({ totalMinor: 100n, fxRate: "0" })).toThrow(PricingInputError);
    expect(() => customerUsd({ totalMinor: 5 as unknown as bigint, fxRate: "127" })).toThrow(
      TypeError,
    );
  });

  it("property: the BDT charged equals usdToBdtMinor of the USD shown, for every total and rate", () => {
    // deterministic pseudo random (no Math.random): a 64-bit LCG over bigint
    let seed = 123456789n;
    const next = (mod: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % mod;
    };
    const rates = [
      "50",
      "86.5",
      "100",
      "117.3333",
      "124.77",
      "127",
      "127.123456",
      "300",
      "500",
      "999.999999",
    ];
    for (let i = 0; i < 4000; i += 1) {
      const total = next(100_000_000n);
      const fx = rates[Number(next(BigInt(rates.length)))]!;
      const price = customerUsd({ totalMinor: total, fxRate: fx });
      expect(usdToBdtMinor(price.micro, fx)).toBe(total);
      expect(price.text).toBe(usdMicroText(price.micro));
      expect(price.text).toMatch(/^\d+\.\d{2,6}$/);
    }
  });

  it("property: the same holds for totals the real engine produces", () => {
    for (const aws of ["0.0050", "0.5", "3.5", "9.5", "44", "84", "1234.5678"]) {
      for (const fx of ["86", "122.5", "127", "131.45"]) {
        const q = quote({ awsPriceUsd: aws, fxRate: fx, rule: LAUNCH });
        expect(usdToBdtMinor(customerUsd(q).micro, fx)).toBe(q.totalMinor);
      }
    }
  });
});

describe("usdMicroText", () => {
  it("is plain decimal text with at least two decimals and no trailing zeros beyond them", () => {
    expect(usdMicroText(0n)).toBe("0.00");
    expect(usdMicroText(5_000_000n)).toBe("5.00");
    expect(usdMicroText(5_850_000n)).toBe("5.85");
    expect(usdMicroText(5_850_300n)).toBe("5.8503");
    expect(usdMicroText(1n)).toBe("0.000001");
    expect(usdMicroText(1_234_567_890n)).toBe("1234.56789");
  });
  it("refuses a number or a negative amount", () => {
    expect(() => usdMicroText(1 as unknown as bigint)).toThrow(TypeError);
    expect(() => usdMicroText(-1n)).toThrow(RangeError);
  });
});
