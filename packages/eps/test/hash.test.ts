import { expect, it } from "vitest";
import { epsHash } from "../hash";

// A plainly fake key built at run time.
const key = "k".repeat(16);

it("is base64 of HMAC-SHA512 (UTF-8 key and value), pinned by a vector", () => {
  // computed with: printf 'abc' | openssl dgst -sha512 -hmac kkkkkkkkkkkkkkkk -binary | base64
  expect(epsHash(key, "abc")).toBe(
    "yyvc9+NWjFlI/Z8SQpE48G2AGTdIaYl84Lxu1SQnL1kg6pQmw2L9xoQYLfEj3wxn0V5k9dSPb/VwuDRgUx7u1w==",
  );
});

it("gives 88 base64 characters (64 bytes with padding)", () => {
  const h = epsHash(key, "TCP" + "0".repeat(32));
  expect(h).toHaveLength(88);
  expect(Buffer.from(h, "base64")).toHaveLength(64);
});

it("depends on both key and value", () => {
  expect(epsHash(key, "a")).not.toBe(epsHash(key, "b"));
  expect(epsHash(key, "a")).not.toBe(epsHash("j".repeat(16), "a"));
});

it("refuses an empty key or an empty value (fail closed)", () => {
  expect(() => epsHash("", "abc")).toThrow(TypeError);
  expect(() => epsHash(key, "")).toThrow(TypeError);
  expect(() => epsHash("", "")).toThrow("eps hash: empty key");
});
