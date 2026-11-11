import { expect, it } from "vitest";
import * as entry from "../index";

it("@tc/notify exports the OTP service, the SMS port and the client-address helper, and none of the hashing helpers", () => {
  for (const n of [
    "sendPhoneOtp",
    "verifyPhoneOtp",
    "otpSmsText",
    "assertPepper",
    "viewerAddress",
    "InMemorySmsProvider",
  ]) {
    expect(typeof (entry as Record<string, unknown>)[n], n).toBe("function");
  }
  expect(entry.OTP.maxAttempts).toBe(5);
  expect(entry.OTP_SEND_RULES).toHaveLength(3);
  for (const n of [
    "hashCode",
    "codeMatches",
    "generateCode",
    "challengeIdFor",
    "phoneSubject",
    "ipSubject",
    "limitAddress",
  ]) {
    expect(Object.keys(entry), n).not.toContain(n);
  }
});
