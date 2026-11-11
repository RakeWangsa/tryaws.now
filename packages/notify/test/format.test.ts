import { expect, it } from "vitest";
import { escapeHtml, fill, formatDhakaDate, formatMoney } from "../text/format";

it("formats money from bigint paisa with two decimals and no float", () => {
  expect(formatMoney(150000n, "en", "latn")).toBe("BDT 1,500.00");
  expect(formatMoney("5", "en", "latn")).toBe("BDT 0.05");
  expect(formatMoney(0n, "en", "latn")).toBe("BDT 0.00");
  expect(formatMoney(123456789n, "en", "latn")).toBe("BDT 1,234,567.89");
  // the English text is ASCII, so an English SMS stays GSM-7
  expect(/^[\x20-\x7e]*$/.test(formatMoney(99999999n, "en", "beng"))).toBe(true);
});

it("formats money in Bengali with the taka sign, lakh grouping and the numerals of the market", () => {
  expect(formatMoney(12345678n, "bn", "beng")).toBe("৳১,২৩,৪৫৬.৭৮");
  expect(formatMoney(12345678n, "bn", "latn")).toBe("৳1,23,456.78");
  expect(formatMoney(150000n, "bn", "beng")).toBe("৳১,৫০০.০০");
});

it("refuses a negative amount, a float and a malformed string", () => {
  expect(() => formatMoney(-1n, "en", "latn")).toThrow(TypeError);
  expect(() => formatMoney("1.5", "en", "latn")).toThrow(TypeError);
  expect(() => formatMoney(1.5 as unknown as bigint, "en", "latn")).toThrow(TypeError);
});

it("shows a date in Asia/Dhaka time, not UTC", () => {
  // 20:00 UTC on 10 November is 02:00 on 11 November in Dhaka
  expect(formatDhakaDate("2026-11-10T20:00:00.000Z", "en", "latn")).toBe("11 Nov 2026");
  expect(formatDhakaDate("2026-11-10T20:00:00.000Z", "bn", "beng")).toBe("১১ নভেম্বর ২০২৬");
  expect(formatDhakaDate("2026-11-10T20:00:00.000Z", "bn", "latn")).toBe("11 নভেম্বর 2026");
  expect(() => formatDhakaDate("not a date", "en", "latn")).toThrow(TypeError);
});

it("fills placeholders in one pass and never re-reads a value", () => {
  expect(fill("a {x} b {y}", { x: "{y}", y: "2" })).toBe("a {y} b 2");
  expect(() => fill("a {x}", {})).toThrow(TypeError);
  expect(() => fill("a", { x: "1" })).toThrow(TypeError);
});

it("escapes the five HTML characters", () => {
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});
