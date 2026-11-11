import { createHmac } from "node:crypto";

/**
 * x-hash of EPS: base64(HMAC-SHA512(key, value)), key and value as UTF-8 text.
 * VERIFY (open points 5 and 6.2): key used as text, not base64-decoded.
 * Throws on an empty key or value (R16: never sign with nothing).
 */
export function epsHash(hashKey: string, value: string): string {
  if (typeof hashKey !== "string" || hashKey.length === 0)
    throw new TypeError("eps hash: empty key");
  if (typeof value !== "string" || value.length === 0) throw new TypeError("eps hash: empty value");
  return createHmac("sha512", hashKey).update(value, "utf8").digest("base64");
}
