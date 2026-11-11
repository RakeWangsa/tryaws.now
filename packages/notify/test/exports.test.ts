import { expect, it } from "vitest";
import * as entry from "../index";

// WP2-T2 exports ipSubject and emailSubject: the auth limiter of apps/web builds its keys from them
// (they need the secret key, so they reveal nothing without it). The code hashing helpers stay private.
it("@tc/notify exports the OTP service, the SMS port, the client-address helper and the two limiter subjects, and none of the hashing helpers", () => {
  for (const n of [
    "sendPhoneOtp",
    "verifyPhoneOtp",
    "otpSmsText",
    "assertPepper",
    "viewerAddress",
    "InMemorySmsProvider",
    "ipSubject",
    "emailSubject",
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
    "limitAddress",
  ]) {
    expect(Object.keys(entry), n).not.toContain(n);
  }
});
