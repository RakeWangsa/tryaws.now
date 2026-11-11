import { expect, it } from "vitest";
import { maskPhone, normalizeBdMobile } from "./phone";

const E = "+8801712345678";
it.each([
  ["+8801712345678", E],
  ["8801712345678", E],
  ["008801712345678", E],
  ["01712345678", E],
  ["1712345678", E],
  ["+880 1712-345678", E],
  ["+880 (0) 1712 345 678", E],
  ["+88001712345678", E],
  ["001712345678", E],
  ["০১৭১২৩৪৫৬৭৮", E],
  ["+৮৮০১৭১২৩৪৫৬৭৮", E],
  ["‎+880 1712345678‏", E],
  ["01312345678", "+8801312345678"],
  ["01912345678", "+8801912345678"],
])("%s is %s", (input, expected) => {
  expect(normalizeBdMobile(input)).toBe(expected);
});

it.each([
  "0171234567",
  "017123456789",
  "01212345678",
  "01012345678",
  "0255501234",
  "+919876543210",
  "+8801712345678x",
  "abc",
  "",
  "+880",
  "+88017123456789",
  "++8801712345678",
  "1112345678",
])("%j is not a Bangladesh mobile number", (input) => {
  expect(normalizeBdMobile(input)).toBeNull();
});

it("a value that is not a string is null, not an exception", () => {
  expect(normalizeBdMobile(undefined as unknown as string)).toBeNull();
  expect(normalizeBdMobile(1712345678 as unknown as string)).toBeNull();
});

it("maskPhone keeps +880 and the last three digits and refuses anything else", () => {
  expect(maskPhone(E)).toBe("+880*******678");
  expect(maskPhone(E)).toHaveLength(E.length);
  for (const bad of ["01712345678", "+8801712", "", "+880171234567a"]) {
    expect(() => maskPhone(bad)).toThrow(
      new TypeError("maskPhone: not a canonical +880 mobile number"),
    );
  }
});
