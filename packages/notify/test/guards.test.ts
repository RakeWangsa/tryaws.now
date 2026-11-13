import { expect, it } from "vitest";
import { scanSecrets, smsLength } from "../text/guards";

it.each([
  ["a 40 hex digest", "ref 0123456789abcdef0123456789abcdef01234567"],
  ["an AWS access key", "key AKIAIOSFODNN7EXAMPLE here"],
  ["a private key block", "-----BEGIN PRIVATE KEY-----"],
  ["a password assignment", "password: hunter2"],
  ["a token assignment", "token=abc"],
  ["a bearer header", "Bearer abcdefghij"],
  ["a full local phone number", "call 01712345678"],
  ["a full international phone number", "call +880 1712 345678"],
  ["a Bengali-digit phone number", "০১৭১২৩৪৫৬৭৮"],
  ["a long digit run (a document number)", "NID 1234567890123"],
  ["an email address", "mail rahim@example.test"],
])("refuses %s", (_name, text) => {
  expect(scanSecrets(text)).not.toBeNull();
});

it("returns the name of the rule and never the text", () => {
  const rule = scanSecrets("password: hunter2");
  expect(rule).toBe("secret_word");
  expect(rule).not.toContain("hunter2");
});

it.each([
  "Your top-up of BDT 1,500.00 was received. Balance BDT 3,000.00.",
  "Invoice TC-2026-000123 is ready.",
  "Your Cloud Server is ready in Asia Pacific (Singapore): 203.0.113.10",
  "আপনার ব্যালেন্স ৳১,২৩,৪৫৬.৭৮",
])("accepts ordinary text: %s", (text) => {
  expect(scanSecrets(text)).toBeNull();
});

// WPU-Z5: a UUID is the id of a row, never a secret. Its digits must not read as a document number or a
// phone number: a request id whose last group is all digits refused every reply notice of the request
// (about 1 random id in 280), and the same id in a data field refused the notice at queue time.
it.each([
  "Open the request: https://tryaws.now/en/support/requests/0193f7c6-4d5e-5394-8f82-123456789012",
  "0193F7C6-4D5E-5394-8F82-123456789012",
  "id 0193f7c6-0171-5234-8567-890123456789 here",
  "০১৯৩f7c6-4d5e-5394-8f82-১২৩৪৫৬৭৮৯০১২",
])("accepts a UUID whatever its digits: %s", (text) => {
  expect(scanSecrets(text)).toBeNull();
});

it.each([
  ["a phone number next to a UUID", "0193f7c6-4d5e-5394-8f82-89abcdef0123 call 01712345678"],
  ["a document number next to a UUID", "NID 1234567890123 0193f7c6-4d5e-5394-8f82-89abcdef0123"],
  ["a digit run glued to a UUID", "0193f7c6-4d5e-5394-8f82-89abcdef0123-123456789012"],
  ["a UUID-long hex without hyphens", "0193f7c64d5e53948f82123456789012"],
  ["a token that is a UUID", "token: 0193f7c6-4d5e-5394-8f82-123456789012"],
])("still refuses %s", (_name, text) => {
  expect(scanSecrets(text)).not.toBeNull();
});

it("measures an SMS: GSM-7 ascii is 160 per segment, anything else is UCS-2 at 70", () => {
  expect(smsLength("a".repeat(160))).toEqual({ encoding: "gsm7", chars: 160, segments: 1 });
  expect(smsLength("a".repeat(161))).toEqual({ encoding: "gsm7", chars: 161, segments: 2 });
  expect(smsLength("আ".repeat(70))).toEqual({ encoding: "ucs2", chars: 70, segments: 1 });
  expect(smsLength("আ".repeat(71))).toEqual({ encoding: "ucs2", chars: 71, segments: 2 });
  expect(smsLength("price ৳5").encoding).toBe("ucs2");
});
