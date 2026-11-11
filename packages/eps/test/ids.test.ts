import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import {
  MERCHANT_TRANSACTION_ID,
  newMerchantTransactionId,
  parseMerchantTransactionId,
} from "../ids";

it("makes 10000 distinct 35-character ids that match the pattern", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = newMerchantTransactionId(randomBytes);
    expect(id).toHaveLength(35);
    expect(MERCHANT_TRANSACTION_ID.test(id)).toBe(true);
    seen.add(id);
  }
  expect(seen.size).toBe(10_000);
});

it("uses the 16 bytes of the generator as lower-case hex", () => {
  const id = newMerchantTransactionId((n) => new Uint8Array(n).fill(0xab));
  expect(id).toBe("TCP" + "ab".repeat(16));
});

it("fails closed when the generator returns fewer than 16 bytes", () => {
  expect(() => newMerchantTransactionId(() => new Uint8Array(15))).toThrow();
  expect(() => newMerchantTransactionId(() => new Uint8Array(0))).toThrow();
});

it("parses only an exact id", () => {
  const good = "TCP" + "0123456789abcdef".repeat(2);
  expect(parseMerchantTransactionId(good)).toBe(good);
  expect(parseMerchantTransactionId("TCP" + "A".repeat(32))).toBeNull();
  expect(parseMerchantTransactionId("TCP" + "a".repeat(31))).toBeNull();
  expect(parseMerchantTransactionId("TCP" + "a".repeat(33))).toBeNull();
  expect(parseMerchantTransactionId(" " + good)).toBeNull();
  expect(parseMerchantTransactionId(good + "\n")).toBeNull();
  expect(parseMerchantTransactionId("tcp" + "a".repeat(32))).toBeNull();
  expect(parseMerchantTransactionId(12345)).toBeNull();
  expect(parseMerchantTransactionId(null)).toBeNull();
  expect(parseMerchantTransactionId({ toString: () => good })).toBeNull();
});
