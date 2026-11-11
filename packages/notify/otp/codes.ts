import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

const STORED_HASH = /^v1\.([0-9a-f]{64})$/;

// R16: a key that is missing or short stops every derivation. The message is fixed text and never
// holds the key (R3, R14).
export function assertPepper(pepper: string): void {
  if (typeof pepper !== "string" || pepper.length < 32) {
    throw new TypeError("otp: the hashing key is missing or shorter than 32 characters");
  }
}

// One key, four derivations (domain separation): HMAC-SHA-256 over the label, then each part,
// joined by a NUL byte. Internal to the package; keys.ts uses it too.
export function mac(pepper: string, label: string, ...parts: readonly string[]): Buffer {
  assertPepper(pepper);
  return createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update([label, ...parts].join("\0"), "utf8")
    .digest();
}

// Six digits, zero padded. The default source is the CSPRNG of node:crypto.
export function generateCode(
  random: (maxExclusive: number) => number = (n) => randomInt(n),
): string {
  return String(random(1_000_000)).padStart(6, "0");
}

const codeMac = (pepper: string, challengeId: string, phone: string, code: string): Buffer =>
  mac(pepper, "tc.otp.code.v1", challengeId, phone, code);

// Bound to the challenge and the number, so a hash cannot be copied to another row.
export function hashCode(pepper: string, challengeId: string, phone: string, code: string): string {
  return "v1." + codeMac(pepper, challengeId, phone, code).toString("hex");
}

// Constant time: timingSafeEqual always runs, on two 32-byte buffers, also for a stored value that
// is not a v1 hash (compared against zeros, and then answered false). It never throws for `stored`.
export function codeMatches(
  pepper: string,
  challengeId: string,
  phone: string,
  code: string,
  stored: string,
): boolean {
  const expected = codeMac(pepper, challengeId, phone, code);
  const found = typeof stored === "string" ? STORED_HASH.exec(stored) : null;
  const candidate = found === null ? Buffer.alloc(32) : Buffer.from(found[1] as string, "hex");
  const equal = timingSafeEqual(expected, candidate);
  return found !== null && equal;
}
