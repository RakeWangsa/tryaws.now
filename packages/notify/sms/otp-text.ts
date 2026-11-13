// The market setting `numerals` of 16.13: Bengali or Latin digits for counts (the templates and the
// formatters use it; the OTP text below has no count).
export type Numerals = "beng" | "latn";

// WPU-Z3: the gateway (Gennet) requires its own OTP format with the brand in the body, "(BRAND Name) Your
// OTP is: 111111. Please do not share your OTP with anyone.". Ruling: English for every locale, so that
// the operator's template matches. It is one GSM 7-bit message (70 characters), with no link (an
// unregistered A2P SMS with a link is filtered by operators) and no AWS name (16.13). The code is a
// technical value in Latin digits, which keeps the one-time-code autofill of phones working. The fixed
// TypeError text never holds the code (R14).
export function otpSmsText(code: string): string {
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    throw new TypeError("otpSmsText: the code is not six digits");
  }
  return `MeghVPS Your OTP is: ${code}. Please do not share your OTP with anyone.`;
}
