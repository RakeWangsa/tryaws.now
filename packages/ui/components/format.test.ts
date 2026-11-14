import { describe, expect, it } from "vitest";
import { TAKA, formatDate, formatMoney, formatUsd, toDate } from "./format";

const en = { locale: "en" as const };
const bn = { locale: "bn" as const };

describe("formatMoney", () => {
  it("formats exact amounts", () => {
    expect(TAKA).toBe("৳");
    expect(formatMoney(0n, en)).toBe("৳0.00");
    expect(formatMoney(5n, en)).toBe("৳0.05");
    expect(formatMoney(123450n, en)).toBe("৳1,234.50");
    expect(formatMoney(123450n, bn)).toBe("৳১,২৩৪.৫০");
  });
  it("switches numerals", () => {
    expect(formatMoney(123450n, { ...bn, numerals: "latn" })).toBe("৳1,234.50");
    expect(formatMoney(123450n, { ...en, numerals: "beng" })).toBe("৳১,২৩৪.৫০");
  });
  it("puts the sign before the taka mark", () => {
    expect(formatMoney(-505n, en)).toBe("-৳5.05");
  });
  it("uses lakh grouping in bn", () => {
    expect(formatMoney(12345678950n, bn)).toBe("৳১২,৩৪,৫৬,৭৮৯.৫০");
    expect(formatMoney(123456789050n, bn)).toBe("৳১,২৩,৪৫,৬৭,৮৯০.৫০");
  });
  it("loses no digit above 2^53", () => {
    expect(formatMoney(12345678901234567n, en)).toBe("৳123,456,789,012,345.67");
  });
  it("rounds up to whole taka with wholeUp", () => {
    expect(formatMoney(100001n, { ...en, mode: "wholeUp" })).toBe("৳1,001");
    expect(formatMoney(100000n, { ...en, mode: "wholeUp" })).toBe("৳1,000");
    expect(formatMoney(1n, { ...en, mode: "wholeUp" })).toBe("৳1");
    expect(() => formatMoney(-1n, { ...en, mode: "wholeUp" })).toThrow(RangeError);
  });
  it("refuses a number", () => {
    expect(() => formatMoney(5 as unknown as bigint, en)).toThrow(TypeError);
  });
});

describe("formatDate", () => {
  it("shows Asia/Dhaka time (UTC+6 rolls the day over)", () => {
    expect(formatDate("2026-11-11T18:30:00Z", { locale: "en", variant: "datetime" })).toContain(
      "Nov 12, 2026",
    );
    expect(formatDate("2026-11-11T18:30:00Z", { locale: "bn", variant: "date" })).toBe(
      "১২ নভে, ২০২৬",
    );
  });
  it("refuses a string without zone and an invalid date", () => {
    expect(() => formatDate("2026-11-11T18:30:00", en)).toThrow(RangeError);
    expect(() => formatDate("2026-13-45T00:00:00Z", en)).toThrow(RangeError);
    expect(() => formatDate(new Date(Number.NaN), en)).toThrow(RangeError);
  });
  it("accepts a Date and its ISO string alike", () => {
    const iso = "2026-11-11T18:30:00.000Z";
    expect(formatDate(new Date(iso), en)).toBe(formatDate(iso, en));
  });
  it("supports the time variant and a numerals override", () => {
    expect(formatDate("2026-11-11T18:30:00Z", { locale: "en", variant: "time" })).toMatch(/12:30/);
    expect(formatDate("2026-11-11T18:30:00Z", { locale: "en", numerals: "beng" })).toContain("১২");
  });
});

describe("formatUsd (WPU-Y4)", () => {
  it("writes dollars from decimal text with at least two decimals and every given decimal", () => {
    expect(formatUsd("5.85", { locale: "en" })).toBe("$5.85");
    expect(formatUsd("5", { locale: "en" })).toBe("$5.00");
    expect(formatUsd("0.585", { locale: "en" })).toBe("$0.585");
    expect(formatUsd("1234.5", { locale: "en" })).toBe("$1,234.50");
  });
  it("uses Bengali digits in bn and Latin digits when asked", () => {
    expect(formatUsd("5.85", { locale: "bn" })).toBe("$৫.৮৫");
    expect(formatUsd("5.85", { locale: "bn", numerals: "latn" })).toBe("$5.85");
  });
  it("refuses anything that is not plain decimal text", () => {
    expect(() => formatUsd("1e3", { locale: "en" })).toThrow(RangeError);
    expect(() => formatUsd("-1", { locale: "en" })).toThrow(RangeError);
    expect(() => formatUsd(5 as never, { locale: "en" })).toThrow(RangeError);
  });
});

// Staging 2026-11-14: the admin customers page crashed. Raw SQL returns timestamptz as PostgreSQL text
// ("2026-11-14 12:15:52.469566+00": a space, microseconds, an hour-only offset), which toDate refused.
describe("toDate accepts PostgreSQL timestamptz text", () => {
  it("reads a space separator, microseconds and a +HH offset", () => {
    expect(toDate("2026-11-14 12:15:52.469566+00").toISOString()).toBe("2026-11-14T12:15:52.469Z");
    expect(toDate("2026-11-14 18:15:52+06").toISOString()).toBe("2026-11-14T12:15:52.000Z");
    expect(toDate("2026-11-14 06:45:00-05:30").toISOString()).toBe("2026-11-14T12:15:00.000Z");
  });

  it("still refuses a moment without a zone (R16)", () => {
    expect(() => toDate("2026-11-14 12:15:52")).toThrow(RangeError);
    expect(() => toDate("2026-11-14T12:15:52.469566")).toThrow(RangeError);
  });
});
