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

// WPU-Z5: the id of a support request in its panel path is set aside, so that a request id whose last
// group is all digits (about 1 random id in 280) does not read as a document number. Only that id, in that
// path, with no token character after it: a token glued to an id is never split.
const DIGIT_ID = "0193f7c6-4d5e-5394-8f82-123456789012";

it.each([
  `Open the request: https://tryaws.now/en/support/requests/${DIGIT_ID}`,
  `https://tryaws.now/support/requests/${DIGIT_ID.toUpperCase()}\nThanks`,
  "https://tryaws.now/support/requests/০১৯৩f7c6-4d5e-5394-8f82-১২৩৪৫৬৭৮৯০১২ ",
])("accepts the id of a request in its panel path: %s", (text) => {
  expect(scanSecrets(text)).toBeNull();
});

it.each([
  ["prefix_<uuid>", `key sk_${"a".repeat(30)}_${"0193f7c6-4d5e-5394-8f82-89abcdef0123"}`],
  ["prefix_<uuid> with an all-digit id", `ref_${DIGIT_ID}`],
  ["<uuid>@domain", `write to ${DIGIT_ID}@example.test`],
  ["<uuid>@domain in the request path", `https://x.test/support/requests/${DIGIT_ID}@example.test`],
  ["prefix_<uuid> in the request path", `/support/requests/sk_${DIGIT_ID}`],
  ["digits glued to the id of the path", `/support/requests/${DIGIT_ID}0`],
  ["a token after the id of the path", `/support/requests/${DIGIT_ID}_${"a".repeat(40)}`],
  ["a UUID outside the request path", `id ${DIGIT_ID} here`],
  ["a token that is a request path id", `token: /support/requests/${DIGIT_ID}`],
  ["a phone number next to the path", `/support/requests/${DIGIT_ID} call 01712345678`],
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
