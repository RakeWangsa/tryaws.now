import { expect, it } from "vitest";
import { toAsciiDigits } from "./digits";
import { parseOtpCode } from "./otp-code";

it.each([
  ["123456", "123456"],
  ["000042", "000042"],
  ["০০০০৪২", "000042"],
  [" 123 456 ", "123456"],
  ["123-456", "123456"],
  ["‎123456‏", "123456"],
])("%j is the code %s", (input, expected) => {
  expect(parseOtpCode(input)).toBe(expected);
});

it.each(["42", "1234567", "12345a", "", "12 34 5"])(
  "%j is not a code (a number would lose its zeros)",
  (input) => {
    expect(parseOtpCode(input)).toBeNull();
  },
);

it("toAsciiDigits maps the ten Bengali digits and leaves the rest", () => {
  expect(toAsciiDigits("০১২৩৪৫৬৭৮৯ abc +")).toBe("0123456789 abc +");
});
