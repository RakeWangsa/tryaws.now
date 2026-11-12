import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSshKeyInput } from "../../../../../server/ssh-key.ts";
import {
  fileNameOfPrivateKey,
  generateEd25519KeyPair,
  openSshPrivateKeyOf,
  openSshPublicLineOf,
} from "./ssh-keygen.ts";

// WPU-G10. The browser makes a key pair like the Lightsail console does: Ed25519 from Web Crypto, in the
// OpenSSH formats. The private key is built here, in memory; nothing in this module sends it anywhere.
// The real OpenSSH tool reading the file is proved in tests/repo/ssh-keygen-openssh.test.mjs (a test of an
// app may not start a process, R1).
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

/** The fields of an openssh-key-v1 file (no encryption): the public key and the 64 byte private part. */
function readOpenSshFile(pem: string): { publicKey: Buffer; seed: Buffer; comment: string } {
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
  str(); // the public blob
  const inner = str();
  let i = 0;
  const check1 = inner.readUInt32BE(i);
  const check2 = inner.readUInt32BE(i + 4);
  expect(check1).toBe(check2);
  i += 8;
  const take = (): Buffer => {
    const n = inner.readUInt32BE(i);
    i += 4;
    const out = inner.subarray(i, i + n);
    i += n;
    return out;
  };
  expect(take().toString()).toBe("ssh-ed25519");
  const publicKey = take();
  const secret = take(); // seed and public key
  const comment = take().toString();
  // padding 1, 2, 3 ... to a multiple of 8
  expect((inner.length - 0) % 8).toBe(0);
  return { publicKey, seed: secret.subarray(0, 32), comment };
}

describe("the OpenSSH formats", () => {
  it("writes a public line of the type and the base64 blob that the key page accepts", () => {
    const line = openSshPublicLineOf(PUB);
    expect(line.startsWith("ssh-ed25519 ")).toBe(true);
    expect(line.split(" ")).toHaveLength(2); // no comment: the name is the customer's, stored beside
    expect(parseSshKeyInput({ name: "web-1", publicKey: line }).ok).toBe(true);
  });

  it("writes the private key as an unencrypted OpenSSH file with 70 column lines", () => {
    const pem = openSshPrivateKeyOf(SEED, PUB, "web-1");
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(lines.at(-1)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(lines.slice(1, -1).every((l) => l.length <= 70)).toBe(true);
    expect(pem.endsWith("\n")).toBe(true);
    const parsed = readOpenSshFile(pem);
    expect([...parsed.publicKey]).toEqual([...PUB]);
    expect([...parsed.seed]).toEqual([...SEED]);
    expect(parsed.comment).toBe("web-1");
  });

  it("refuses a seed or a public key of the wrong size", () => {
    expect(() => openSshPrivateKeyOf(new Uint8Array(31), PUB, "x")).toThrow(RangeError);
    expect(() => openSshPrivateKeyOf(SEED, new Uint8Array(33), "x")).toThrow(RangeError);
    expect(() => openSshPublicLineOf(new Uint8Array(31))).toThrow(RangeError);
  });

  it("names the file after the key and keeps only safe characters", () => {
    expect(fileNameOfPrivateKey("my key.1")).toBe("my-key.1.pem");
    expect(fileNameOfPrivateKey("../../etc")).toBe("etc.pem");
    expect(fileNameOfPrivateKey("")).toBe("tc-key.pem");
  });
});

describe("generateEd25519KeyPair (Web Crypto)", () => {
  it("makes a pair whose public key the key page accepts, and two calls differ", async () => {
    const a = await generateEd25519KeyPair("k");
    const b = await generateEd25519KeyPair("k");
    expect(parseSshKeyInput({ name: "k", publicKey: a.publicKey }).ok).toBe(true);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    // the public part is not the private part
    expect(a.privateKey).not.toContain(a.publicKey.split(" ")[1] as string);
  });

  it("the private part of the file belongs to the public line: the seed signs and the public key verifies", async () => {
    const pair = await generateEd25519KeyPair("agree");
    const file = readOpenSshFile(pair.privateKey);
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      file.seed,
    ]);
    const secret = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    // the public key derived from the seed is the one in the file and in the line
    const jwk = createPublicKey(secret).export({ format: "jwk" });
    const derived = Buffer.from(jwk.x as string, "base64url");
    expect([...derived]).toEqual([...file.publicKey]);
    const blob = Buffer.from(pair.publicKey.split(" ")[1] as string, "base64");
    expect(blob.subarray(-32).equals(derived)).toBe(true);
    const message = Buffer.from("proof");
    const signature = sign(null, message, secret);
    expect(verify(null, message, createPublicKey(secret), signature)).toBe(true);
    // and the fingerprint the platform stores is the SHA-256 of that blob
    const parsed = parseSshKeyInput({ name: "agree", publicKey: pair.publicKey });
    if (!parsed.ok) throw new Error("not accepted");
    const expected = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    expect(parsed.value.fingerprint).toContain(expected);
  });
});

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
