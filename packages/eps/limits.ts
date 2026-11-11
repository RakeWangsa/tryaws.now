import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { CustomerLimit } from "@tc/db";

// Open point 8: constants in one place. The rules are frozen so no caller can change them at run time.
export const START_LIMITS = Object.freeze({
  customer: Object.freeze([
    Object.freeze({ action: "eps.start", limit: 5, windowSeconds: 600 }),
    Object.freeze({ action: "eps.start.day", limit: 20, windowSeconds: 86400 }),
  ]) as readonly CustomerLimit[],
  ip: Object.freeze({ action: "eps.start", limit: 20, windowSeconds: 3600 }),
});

export const RETURN_LIMITS = Object.freeze({
  ip: Object.freeze({ action: "eps.return", limit: 60, windowSeconds: 60 }),
  payment: Object.freeze({ action: "eps.verify", limit: 1, windowSeconds: 5 }),
});

// The status page asks the server to re-check an open payment (WP3-T4). The per-payment pause and the
// per-address rule are those of RETURN_LIMITS, applied inside verifyPayment.
export const RECHECK_LIMITS = Object.freeze({
  customer: Object.freeze({
    action: "eps.recheck",
    limit: 30,
    windowSeconds: 600,
  }) as CustomerLimit,
});

// One group of an IPv6 address as a number, digit by digit (no parseInt: the boundary test bans it
// for the whole package). Anything that is not a hex digit gives NaN, which the caller refuses.
const HEX_DIGITS = "0123456789abcdef";
const hextet = (h: string): number => {
  if (h.length < 1 || h.length > 4) return Number.NaN;
  let n = 0;
  for (const ch of h.toLowerCase()) {
    const d = HEX_DIGITS.indexOf(ch);
    if (d < 0) return Number.NaN;
    n = n * 16 + d;
  }
  return n;
};

/** The address a limit counts: IPv4 as it is, IPv4-mapped IPv6 as its IPv4, other IPv6 as its first 64 bits; null otherwise (R16). */
export function limitAddress(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const bare = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return null;
  let canonical: string;
  try {
    canonical = new URL("http://[" + bare + "]/").hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head = "", tail] = canonical.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - front.length - back.length;
  if (tail === undefined ? front.length !== 8 : missing < 0) return null;
  const groups =
    tail === undefined ? front : [...front, ...Array<string>(missing).fill("0"), ...back];
  const numbers = groups.map(hextet);
  if (numbers.length !== 8 || numbers.some((n) => !Number.isInteger(n))) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = numbers;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  }
  return [a, b, c, d].map((n) => n.toString(16)).join(":");
}

/** The subject of the per-payment verify limit: a keyed hash of the merchant transaction id, so the limiter table never holds it (R14). */
export function paymentSubject(key: string, merchantTransactionId: string): string | null {
  if (typeof key !== "string" || key.length === 0) return null;
  if (typeof merchantTransactionId !== "string" || merchantTransactionId.length === 0) return null;
  return createHmac("sha256", Buffer.from(key, "utf8"))
    .update("tc.rl.payment.v1:eps\0" + merchantTransactionId)
    .digest()
    .subarray(0, 16)
    .toString("hex");
}

/** 128 bits of a keyed hash of the address: the limiter table never holds an address (R14). Null for a bad address. */
export function ipSubject(key: string, ip: unknown): string | null {
  const address = limitAddress(ip);
  if (address === null || typeof key !== "string" || key.length === 0) return null;
  return createHmac("sha256", Buffer.from(key, "utf8"))
    .update("tc.rl.ip.v1:eps\0" + address)
    .digest()
    .subarray(0, 16)
    .toString("hex");
}
