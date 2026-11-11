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

it("measures an SMS: GSM-7 ascii is 160 per segment, anything else is UCS-2 at 70", () => {
  expect(smsLength("a".repeat(160))).toEqual({ encoding: "gsm7", chars: 160, segments: 1 });
  expect(smsLength("a".repeat(161))).toEqual({ encoding: "gsm7", chars: 161, segments: 2 });
  expect(smsLength("আ".repeat(70))).toEqual({ encoding: "ucs2", chars: 70, segments: 1 });
  expect(smsLength("আ".repeat(71))).toEqual({ encoding: "ucs2", chars: 71, segments: 2 });
  expect(smsLength("price ৳5").encoding).toBe("ucs2");
});
