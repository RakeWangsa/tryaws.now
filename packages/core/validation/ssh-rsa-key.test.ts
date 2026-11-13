import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SSH_RSA_MAX_BITS,
  SSH_RSA_MIN_BITS,
  isImportableSshKey,
  sshRsaKeyBits,
} from "./ssh-rsa-key";

// WPU-Y5 (e): Lightsail ImportKeyPair documents publicKeyBase64 as "A base64-encoded public key of the ssh-rsa
// type" (API reference, read 2026-11-14), and no Lightsail page documents Ed25519 or ECDSA
// (docs/analysis/verify-review-2026-11-13.md, JOURNEY.md:427). So the only key a Linux server can be created with
// is an OpenSSH ssh-rsa public key of at least 2048 bits.

/** An OpenSSH public line (`ssh-rsa <base64 blob>`) built by Node from a real RSA key. */
function rsaLine(bits: number): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  return lineOf(
    Buffer.from(jwk.e as string, "base64url"),
    Buffer.from(jwk.n as string, "base64url"),
  );
}

const str = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
function u32(n: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
}
/** An SSH mpint of a positive number: a leading zero byte when the top bit is set. */
const mpint = (b: Buffer): Buffer =>
  str((b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const lineOf = (e: Buffer, n: Buffer, extra = Buffer.alloc(0)): string =>
  `ssh-rsa ${Buffer.concat([str(Buffer.from("ssh-rsa")), mpint(e), mpint(n), extra]).toString("base64")}`;

describe("sshRsaKeyBits", () => {
  it("reads the modulus size of real RSA keys", () => {
    expect(sshRsaKeyBits(rsaLine(2048))).toBe(2048);
    expect(sshRsaKeyBits(rsaLine(3072))).toBe(3072);
    expect(sshRsaKeyBits(rsaLine(1024))).toBe(1024);
  });

  it("refuses everything that is not exactly one ssh-rsa line with a well-formed blob", () => {
    const good = rsaLine(2048);
    const blob = good.split(" ")[1] as string;
    const ed25519 = `ssh-ed25519 ${Buffer.concat([str(Buffer.from("ssh-ed25519")), str(Buffer.alloc(32, 7))]).toString("base64")}`;
    for (const value of [
      "",
      "ssh-rsa",
      `ssh-rsa ${blob} comment`,
      ` ${good}`,
      `${good}\n`,
      `ssh-dss ${blob}`,
      ed25519,
      ed25519.replace("ssh-ed25519 ", "ssh-rsa "),
      `ssh-rsa ${blob}!`,
      `ssh-rsa ${blob.slice(0, -8)}`,
      lineOf(Buffer.from([1, 0, 1]), Buffer.alloc(256, 0xff), Buffer.from([0])), // trailing bytes
      lineOf(Buffer.from([1, 0, 1]), Buffer.alloc(0)), // no modulus
      lineOf(Buffer.alloc(0), Buffer.alloc(256, 0xff)), // no exponent
      `ssh-rsa ${Buffer.concat([str(Buffer.from("ssh-rsa")), str(Buffer.from([0x80, 1])), mpint(Buffer.alloc(256, 0xff))]).toString("base64")}`, // negative exponent
      undefined,
      null,
      42,
    ]) {
      expect(sshRsaKeyBits(value), String(value).slice(0, 40)).toBeNull();
    }
  });
});

describe("isImportableSshKey", () => {
  it(`accepts ssh-rsa keys of ${SSH_RSA_MIN_BITS} to ${SSH_RSA_MAX_BITS} bits only`, () => {
    expect(SSH_RSA_MIN_BITS).toBe(2048);
    expect(isImportableSshKey(rsaLine(2048))).toBe(true);
    expect(isImportableSshKey(rsaLine(4096))).toBe(true);
    expect(isImportableSshKey(rsaLine(1024))).toBe(false);
    expect(
      isImportableSshKey(
        lineOf(Buffer.from([1, 0, 1]), Buffer.alloc(SSH_RSA_MAX_BITS / 8 + 1, 0xff)),
      ),
    ).toBe(false);
    expect(isImportableSshKey("ssh-ed25519 AAAA")).toBe(false);
  });
});
