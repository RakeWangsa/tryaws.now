import { expect, it } from "vitest";
import { otpSmsText } from "../sms/otp-text";

it("English: Latin digits whatever the numerals setting says", () => {
  const text = "TiCON Cloud verification code: 000042. Valid for 5 minutes. Do not share it.";
  expect(otpSmsText("en", "beng", "000042", 5)).toBe(text);
  expect(otpSmsText("en", "latn", "000042", 5)).toBe(text);
});

it("Bengali: the code in Latin digits, the minutes in Bengali digits for beng and in Latin digits for latn", () => {
  expect(otpSmsText("bn", "beng", "000042", 5)).toBe(
    "TiCON Cloud যাচাই কোড: 000042। মেয়াদ ৫ মিনিট। কাউকে জানাবেন না।",
  );
  expect(otpSmsText("bn", "beng", "000042", 10)).toContain("মেয়াদ ১০ মিনিট");
  expect(otpSmsText("bn", "latn", "000042", 5)).toContain("মেয়াদ 5 মিনিট");
});

it("each text fits one SMS: 70 characters for Unicode text, 160 for GSM 7-bit text", () => {
  expect([...otpSmsText("bn", "beng", "123456", 5)].length).toBeLessThanOrEqual(70);
  expect([...otpSmsText("bn", "latn", "123456", 5)].length).toBeLessThanOrEqual(70);
  const en = otpSmsText("en", "beng", "123456", 5);
  expect(en.length).toBeLessThanOrEqual(160);
  expect(en).toMatch(/^[A-Za-z0-9 .,:]+$/);
});

it("holds the code once, no link and no AWS name", () => {
  for (const locale of ["bn", "en"] as const) {
    const text = otpSmsText(locale, "beng", "123456", 5);
    expect(text.split("123456")).toHaveLength(2);
    expect(text).not.toMatch(/https?:|www\.|\.com|AWS|Amazon/i);
  }
});

it("refuses a locale or numerals it has no text for, a code that is not six digits, and minutes outside 1 to 60", () => {
  expect(() => otpSmsText("fr" as never, "beng", "123456", 5)).toThrow(TypeError);
  expect(() => otpSmsText("bn", "arab" as never, "123456", 5)).toThrow(TypeError);
  for (const code of ["12345", "12345a", "", "1234567"]) {
    expect(() => otpSmsText("en", "beng", code, 5)).toThrow(TypeError);
  }
  for (const minutes of [0, 1.5, 61, Number.NaN]) {
    expect(() => otpSmsText("en", "beng", "123456", minutes)).toThrow(TypeError);
  }
});
