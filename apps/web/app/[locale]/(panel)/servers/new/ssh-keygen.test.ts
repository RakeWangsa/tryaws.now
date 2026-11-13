import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSshKeyInput } from "../../../../../server/ssh-key.ts";
import {
  fileNameOfPrivateKey,
  generateRsaKeyPair,
  openSshPrivateKeyOf,
  openSshPublicLineOf,
  RSA_BITS,
  type RsaKeyParts,
} from "./ssh-keygen.ts";

// WPU-G10, WPU-Y5 (e). The browser makes a key pair like the Lightsail console does: RSA from Web Crypto (Lightsail
// ImportKeyPair takes ssh-rsa keys only), in the OpenSSH formats. The private key is built here, in memory; nothing
// in this module sends it anywhere. The real OpenSSH tool reading the file is proved in
// tests/repo/ssh-keygen-openssh.test.mjs (a test of an app may not start a process, R1).

/** The parts of a real 2048 bit RSA key made by Node, as the browser's JWK gives them. */
function nodeRsa(bits = 2048): { parts: RsaKeyParts } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = privateKey.export({ format: "jwk" });
  const b = (v: unknown) => new Uint8Array(Buffer.from(v as string, "base64url"));
  return {
    parts: { n: b(jwk.n), e: b(jwk.e), d: b(jwk.d), p: b(jwk.p), q: b(jwk.q), qi: b(jwk.qi) },
  };
}
const KEY = nodeRsa();

const unsigned = (b: Buffer): Buffer => (b[0] === 0 ? b.subarray(1) : b);

/** The fields of an openssh-key-v1 file (no encryption) of an ssh-rsa key. */
function readOpenSshFile(pem: string) {
  const body = Buffer.from(
    pem
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("-----"))
      .join(""),
    "base64",
  );
  let at = 15; // "openssh-key-v1\0"
  const u32 = (): number => {
    const n = body.readUInt32BE(at);
    at += 4;
    return n;
  };
  const str = (): Buffer => {
    const n = u32();
    const out = body.subarray(at, at + n);
    at += n;
    return out;
  };
  expect(str().toString()).toBe("none"); // cipher
  expect(str().toString()).toBe("none"); // kdf
  expect(str().length).toBe(0); // kdf options
  expect(u32()).toBe(1); // one key
  const publicBlob = str();
  const inner = str();
  let i = 0;
  expect(inner.readUInt32BE(0)).toBe(inner.readUInt32BE(4));
  i += 8;
  const take = (): Buffer => {
    const n = inner.readUInt32BE(i);
    i += 4;
    const out = inner.subarray(i, i + n);
    i += n;
    return out;
  };
  expect(take().toString()).toBe("ssh-rsa");
  const n = unsigned(take());
  const e = unsigned(take());
  const d = unsigned(take());
  const qi = unsigned(take());
  const p = unsigned(take());
  const q = unsigned(take());
  const comment = take().toString();
  expect(inner.length % 8).toBe(0);
  return { publicBlob, n, e, d, qi, p, q, comment };
}

describe("the OpenSSH formats", () => {
  it("writes a public line of the type and the base64 blob that the key page accepts", () => {
    const line = openSshPublicLineOf(KEY.parts);
    expect(line.startsWith("ssh-rsa ")).toBe(true);
    expect(line.split(" ")).toHaveLength(2); // no comment: the name is the customer's, stored beside
    expect(parseSshKeyInput({ name: "web-1", publicKey: line }).ok).toBe(true);
  });

  it("writes the private key as an unencrypted OpenSSH file with 70 column lines", () => {
    const pem = openSshPrivateKeyOf(KEY.parts, "web-1");
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(lines.at(-1)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(lines.slice(1, -1).every((l) => l.length <= 70)).toBe(true);
    expect(pem.endsWith("\n")).toBe(true);
    const parsed = readOpenSshFile(pem);
    for (const name of ["n", "e", "d", "qi", "p", "q"] as const) {
      expect([...parsed[name]], name).toEqual([...KEY.parts[name]]);
    }
    expect(parsed.comment).toBe("web-1");
    const line = openSshPublicLineOf(KEY.parts);
    expect(parsed.publicBlob.toString("base64")).toBe(line.split(" ")[1]);
  });

  it("refuses a modulus under 2048 bits and a missing private part", () => {
    const small = nodeRsa(1024).parts;
    expect(() => openSshPublicLineOf(small)).toThrow(RangeError);
    expect(() => openSshPrivateKeyOf(small, "x")).toThrow(RangeError);
    expect(() => openSshPrivateKeyOf({ ...KEY.parts, d: new Uint8Array(0) }, "x")).toThrow(
      RangeError,
    );
  });

  it("names the file after the key and keeps only safe characters", () => {
    expect(fileNameOfPrivateKey("my key.1")).toBe("my-key.1.pem");
    expect(fileNameOfPrivateKey("../../etc")).toBe("etc.pem");
    expect(fileNameOfPrivateKey("")).toBe("tc-key.pem");
  });
});

describe("generateRsaKeyPair (Web Crypto)", () => {
  it(`makes a ${RSA_BITS} bit pair whose public key the key page accepts, and two calls differ`, async () => {
    const a = await generateRsaKeyPair("k");
    const b = await generateRsaKeyPair("k");
    expect(parseSshKeyInput({ name: "k", publicKey: a.publicKey }).ok).toBe(true);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    const n = readOpenSshFile(a.privateKey).n;
    expect(n.length * 8).toBe(RSA_BITS);
    expect((n[0] ?? 0) & 0x80).toBe(0x80);
  });

  it("the private part of the file belongs to the public line: the private key signs and the line verifies", async () => {
    const pair = await generateRsaKeyPair("agree");
    const file = readOpenSshFile(pair.privateKey);
    const secret = createPrivateKey({
      key: {
        kty: "RSA",
        n: file.n.toString("base64url"),
        e: file.e.toString("base64url"),
        d: file.d.toString("base64url"),
        p: file.p.toString("base64url"),
        q: file.q.toString("base64url"),
        qi: file.qi.toString("base64url"),
        // dp and dq are not in the OpenSSH file; Node needs them, so they are derived
        dp: bigTo(bigOf(file.d) % (bigOf(file.p) - 1n)),
        dq: bigTo(bigOf(file.d) % (bigOf(file.q) - 1n)),
      },
      format: "jwk",
    });
    const blob = Buffer.from(pair.publicKey.split(" ")[1] as string, "base64");
    expect(blob.equals(file.publicBlob)).toBe(true);
    const publicKey = createPublicKey({
      key: { kty: "RSA", n: file.n.toString("base64url"), e: file.e.toString("base64url") },
      format: "jwk",
    });
    const message = Buffer.from("proof");
    expect(verify("sha256", message, publicKey, sign("sha256", message, secret))).toBe(true);
    // and the fingerprint the platform stores is the SHA-256 of that blob
    const parsed = parseSshKeyInput({ name: "agree", publicKey: pair.publicKey });
    if (!parsed.ok) throw new Error("not accepted");
    const expected = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    expect(parsed.value.fingerprint).toContain(expected);
  });
});

function bigOf(b: Buffer): bigint {
  return BigInt(`0x${b.toString("hex") || "0"}`);
}
function bigTo(v: bigint): string {
  const hex = v.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex").toString("base64url");
}

describe("the module keeps the private key in the browser", () => {
  const source = readFileSync(new URL("./ssh-keygen.ts", import.meta.url), "utf8").replace(
    /\/\/.*$|\/\*[\s\S]*?\*\//gm,
    "",
  );
  it("has no network call, no log and no storage", () => {
    expect(source).not.toMatch(
      /\bfetch\(|XMLHttpRequest|sendBeacon|console\.|localStorage|sessionStorage|indexedDB|document\.cookie/,
    );
  });
});
