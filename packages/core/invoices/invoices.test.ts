import { describe, expect, it } from "vitest";
import {
  InvoiceError,
  buildInvoiceLines,
  fiscalYearOf,
  formatInvoiceNumber,
  formatMinor,
  invoicePdfKey,
  parseLineAmount,
} from "./index";

describe("invoicePdfKey", () => {
  const c = "0190a000-0000-7000-8000-000000000001";
  const i = "0190a000-0000-7000-8000-000000000002";
  it("is derived from the two ids and the locale", () => {
    expect(invoicePdfKey(c, i, "bn")).toBe(`invoices/${c}/${i}.bn.pdf`);
  });
  it("refuses anything that is not a UUID or a known locale (no path from customer text)", () => {
    expect(() => invoicePdfKey("../x", i, "en")).toThrow(InvoiceError);
    expect(() => invoicePdfKey(c, `${i}/../..`, "en")).toThrow(InvoiceError);
    expect(() => invoicePdfKey(c, i, "fr" as never)).toThrow(InvoiceError);
  });
});

describe("fiscalYearOf: July to June, by the Dhaka calendar", () => {
  it("2026 is July 2026 to June 2027", () => {
    expect(fiscalYearOf(new Date("2026-07-01T00:00:00+06:00"))).toBe(2026);
    expect(fiscalYearOf(new Date("2027-06-30T23:59:59+06:00"))).toBe(2026);
    expect(fiscalYearOf(new Date("2027-07-01T00:00:00+06:00"))).toBe(2027);
  });
  it("uses Dhaka time at the boundary, not UTC", () => {
    // 2026-06-30 18:30 UTC is 2026-07-01 00:30 in Dhaka
    expect(fiscalYearOf(new Date("2026-06-30T18:30:00Z"))).toBe(2026);
    expect(fiscalYearOf(new Date("2026-06-30T17:30:00Z"))).toBe(2025);
  });
  it("refuses an invalid date (R16)", () => {
    expect(() => fiscalYearOf(new Date("nope"))).toThrow(InvoiceError);
  });
});

describe("formatInvoiceNumber", () => {
  it("is TC-<year>-<six digits>, always Latin digits", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("TC-2026-000001");
    expect(formatInvoiceNumber(2027, 123456)).toBe("TC-2027-123456");
  });
  it("refuses a number that is not a positive integer", () => {
    expect(() => formatInvoiceNumber(2026, 0)).toThrow(InvoiceError);
    expect(() => formatInvoiceNumber(2026, 1.5)).toThrow(InvoiceError);
  });
});

describe("formatMinor: exact bigint paisa, two decimals", () => {
  it("formats with grouping and two decimals", () => {
    expect(formatMinor(0n, "en")).toBe("0.00");
    expect(formatMinor(5n, "en")).toBe("0.05");
    expect(formatMinor(123456789n, "en")).toBe("1,234,567.89");
  });
  it("uses Bengali digits in bn by default, Latin when the market asks", () => {
    expect(formatMinor(123450n, "bn")).toBe("১,২৩৪.৫০");
    expect(formatMinor(123450n, "bn", "latn")).toBe("1,234.50");
  });
  it("never rounds and survives values beyond 2^53", () => {
    expect(formatMinor(9007199254740993n, "en")).toBe("90,071,992,547,409.93");
  });
  it("refuses a negative amount", () => {
    expect(() => formatMinor(-1n, "en")).toThrow(InvoiceError);
  });
});

const labels = {
  aws: {
    en: "Cloud Server, Amazon Lightsail instance",
    bn: "ক্লাউড সার্ভার, Amazon Lightsail instance",
  },
  steps: {
    margin: { en: "Service fee", bn: "সার্ভিস ফি" },
    vat: { en: "VAT", bn: "ভ্যাট" },
    zero: { en: "Zero", bn: "শূন্য" },
  },
};

describe("buildInvoiceLines: one AWS line, one line per non-zero step, the sum is the total", () => {
  it("skips a zero step and keeps the order", () => {
    const lines = buildInvoiceLines({
      baseMinor: 10000n,
      steps: [
        { code: "margin", amountMinor: 1000n },
        { code: "zero", amountMinor: 0n },
        { code: "vat", amountMinor: 550n },
      ],
      totalMinor: 11550n,
      labels,
    });
    expect(lines.map((l) => [l.kind, l.code, l.amountMinor])).toEqual([
      ["service", "aws", "10000"],
      ["step", "margin", "1000"],
      ["step", "vat", "550"],
    ]);
  });
  it("fails closed when the lines do not add up to the total (R16)", () => {
    expect(() =>
      buildInvoiceLines({
        baseMinor: 10000n,
        steps: [{ code: "vat", amountMinor: 550n }],
        totalMinor: 10000n,
        labels,
      }),
    ).toThrow(InvoiceError);
  });
  it("fails closed for a step without a label", () => {
    expect(() =>
      buildInvoiceLines({
        baseMinor: 1n,
        steps: [{ code: "mystery", amountMinor: 1n }],
        totalMinor: 2n,
        labels,
      }),
    ).toThrow(InvoiceError);
  });
  it("stores amounts as decimal strings and reads them back as bigint", () => {
    expect(parseLineAmount("9007199254740993")).toBe(9007199254740993n);
    expect(() => parseLineAmount("1.5")).toThrow(InvoiceError);
    expect(() => parseLineAmount("-1")).toThrow(InvoiceError);
  });
});
