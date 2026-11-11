import { timingSafeEqual } from "node:crypto";
import { expect, it, vi } from "vitest";
import { assertPepper, codeMatches, generateCode, hashCode } from "../otp/codes";
import { OTP, OTP_IDEMPOTENCY_KEY, OTP_SEND_RULES } from "../otp/policy";
import { PEPPER } from "./harness";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const ID = "0eb0861a-c26d-8d5b-810b-68cc253a7e94";
const PHONE = "+8801712345678";

it("the numbers are the text of 6.1", () => {
  expect(OTP).toEqual({
    codeDigits: 6,
    ttlSeconds: 300,
    maxAttempts: 5,
    clockBehindSeconds: 60,
    resendSeconds: 60,
    sendTimeoutMs: 5000,
  });
  expect(OTP_SEND_RULES).toEqual([
    { kind: "phone", action: "otp.send", limit: 3, windowSeconds: 3600 },
    { kind: "ip", action: "otp.send", limit: 3, windowSeconds: 3600 },
    { kind: "phone", action: "otp.resend", limit: 1, windowSeconds: 60 },
  ]);
  expect(Object.isFrozen(OTP_SEND_RULES)).toBe(true);
  expect(["a-b_c.d:e", "x".repeat(128)].every((k) => OTP_IDEMPOTENCY_KEY.test(k))).toBe(true);
  expect(["", "a b", "x".repeat(129), "a\0b"].some((k) => OTP_IDEMPOTENCY_KEY.test(k))).toBe(false);
});

it("generateCode asks for 1,000,000 values and zero-pads: 42 is 000042", () => {
  const asked: number[] = [];
  expect(generateCode((max) => (asked.push(max), 42))).toBe("000042");
  expect(generateCode(() => 999_999)).toBe("999999");
  expect(generateCode(() => 0)).toBe("000000");
  expect(asked).toEqual([1_000_000]);
  for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[0-9]{6}$/);
});

it("hashCode is v1 plus 64 hex, repeatable, and changes with each of its four inputs; it never holds the code", () => {
  const h = hashCode(PEPPER, ID, PHONE, "000042");
  expect(h).toMatch(/^v1\.[0-9a-f]{64}$/);
  expect(h).toBe("v1.2645c8c5895297a148ee66d1a1895542df455067171f728d609bb0c6d6596d37"); // pins the label and the field order
  for (const other of [
    hashCode(PEPPER + "x", ID, PHONE, "000042"),
    hashCode(PEPPER, ID.replace("0eb", "1eb"), PHONE, "000042"),
    hashCode(PEPPER, ID, "+8801812345678", "000042"),
    hashCode(PEPPER, ID, PHONE, "000043"),
  ])
    expect(other).not.toBe(h);
  expect(h).not.toContain("000042");
});

it("codeMatches is true for the right code and false for a wrong code, number, challenge or key", () => {
  const h = hashCode(PEPPER, ID, PHONE, "000042");
  expect(codeMatches(PEPPER, ID, PHONE, "000042", h)).toBe(true);
  expect(codeMatches(PEPPER, ID, PHONE, "000043", h)).toBe(false);
  expect(codeMatches(PEPPER, ID, "+8801812345678", "000042", h)).toBe(false);
  expect(codeMatches(PEPPER, ID.replace("0eb", "1eb"), PHONE, "000042", h)).toBe(false);
  expect(codeMatches(PEPPER + "x", ID, PHONE, "000042", h)).toBe(false);
});

it("codeMatches is false, and does not throw, for a stored value that is not a v1 hash", () => {
  for (const stored of [
    "",
    "000042",
    "v1.",
    "v1.zz",
    "v2." + "a".repeat(64),
    "v1." + "A".repeat(64),
    "v1." + "a".repeat(63),
  ]) {
    expect(codeMatches(PEPPER, ID, PHONE, "000042", stored), stored).toBe(false);
  }
});

it("the comparison is constant time: timingSafeEqual runs on two 32-byte buffers for a match, a mismatch and a malformed value", () => {
  const spy = vi.mocked(timingSafeEqual);
  spy.mockClear();
  const h = hashCode(PEPPER, ID, PHONE, "000042");
  codeMatches(PEPPER, ID, PHONE, "000042", h);
  codeMatches(PEPPER, ID, PHONE, "000043", h);
  codeMatches(PEPPER, ID, PHONE, "000042", "garbage");
  expect(spy).toHaveBeenCalledTimes(3);
  for (const [a, b] of spy.mock.calls) expect([a.byteLength, b.byteLength]).toEqual([32, 32]);
});

it("a key that is not a string of 32 characters is a TypeError, also inside hashCode", () => {
  expect(() => assertPepper("k".repeat(31))).toThrow(
    new TypeError("otp: the hashing key is missing or shorter than 32 characters"),
  );
  expect(() => assertPepper(undefined as unknown as string)).toThrow(TypeError);
  expect(() => assertPepper("k".repeat(32))).not.toThrow();
  expect(() => hashCode("short", ID, PHONE, "000042")).toThrow(TypeError);
});
