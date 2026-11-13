import { expect, it } from "vitest";
import { otpSmsText } from "../sms/otp-text";

// WPU-Z3: the gateway (Gennet) requires its own OTP format with the brand in the body, in English for
// every locale, so that the operator's template matches.
it("is exactly the provider's OTP format with the brand MeghVPS, the same for every customer", () => {
  expect(otpSmsText("000042")).toBe(
    "MeghVPS Your OTP is: 000042. Please do not share your OTP with anyone.",
  );
  expect(otpSmsText("123456")).toBe(
    "MeghVPS Your OTP is: 123456. Please do not share your OTP with anyone.",
  );
});

it("fits one GSM 7-bit SMS: 160 characters at most, plain ASCII letters, digits and marks", () => {
  const text = otpSmsText("123456");
  expect(text.length).toBeLessThanOrEqual(160);
  expect(text).toMatch(/^[A-Za-z0-9 .,:]+$/);
});

it("holds the code once, no link and no AWS name", () => {
  const text = otpSmsText("123456");
  expect(text.split("123456")).toHaveLength(2);
  expect(text).not.toMatch(/https?:|www\.|\.com|AWS|Amazon|Lightsail/i);
});

it("refuses a code that is not six digits, with a fixed message that holds no code", () => {
  for (const code of ["12345", "12345a", "", "1234567", " 123456", "123456\n", "١٢٣٤٥٦"]) {
    expect(() => otpSmsText(code), JSON.stringify(code)).toThrow(
      new TypeError("otpSmsText: the code is not six digits"),
    );
  }
  for (const code of [123456, null, undefined]) {
    expect(() => otpSmsText(code as never), String(code)).toThrow(TypeError);
  }
});
