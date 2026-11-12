import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

describe("the OpenSSH formats", () => {
  it("writes a public line of the type and the base64 blob that the key page accepts", () => {
    const line = openSshPublicLineOf(PUB, "web-1");
    expect(line.startsWith("ssh-ed25519 ")).toBe(true);
    expect(line.endsWith(" web-1")).toBe(false); // the comment is dropped: the name is the customer's
    const parsed = parseSshKeyInput({ name: "web-1", publicKey: line });
    expect(parsed.ok).toBe(true);
  });

  it("writes the private key as an unencrypted OpenSSH file with 70 column lines", () => {
    const pem = openSshPrivateKeyOf(SEED, PUB, "web-1");
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(lines.at(-1)).toBe("-----END OPENSSH PRIVATE KEY-----");
    expect(lines.slice(1, -1).every((l) => l.length <= 70)).toBe(true);
    expect(pem.endsWith("\n")).toBe(true);
    const body = Buffer.from(lines.slice(1, -1).join(""), "base64");
    expect(body.subarray(0, 15).toString("latin1")).toBe("openssh-key-v1\0");
  });

  it("refuses a seed or a public key of the wrong size", () => {
    expect(() => openSshPrivateKeyOf(new Uint8Array(31), PUB, "x")).toThrow(RangeError);
    expect(() => openSshPrivateKeyOf(SEED, new Uint8Array(33), "x")).toThrow(RangeError);
    expect(() => openSshPublicLineOf(new Uint8Array(31), "x")).toThrow(RangeError);
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

  const hasKeygen = spawnSync("ssh-keygen", ["-h"], { stdio: "ignore" }).error === undefined;
  it.skipIf(!hasKeygen)(
    "the private key file is read by ssh-keygen and gives the same public key (the real OpenSSH tool agrees)",
    async () => {
      const pair = await generateEd25519KeyPair("agree");
      const dir = mkdtempSync(join(tmpdir(), "tc-keygen-"));
      try {
        const file = join(dir, "id");
        writeFileSync(file, pair.privateKey, { mode: 0o600 });
        const out = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
        expect(out.split(" ").slice(0, 2).join(" ")).toBe(
          pair.publicKey.split(" ").slice(0, 2).join(" "),
        );
        // and the fingerprint is the SHA-256 of the blob, as the platform computes it
        const parsed = parseSshKeyInput({ name: "agree", publicKey: pair.publicKey });
        if (!parsed.ok) throw new Error("not accepted");
        const blob = Buffer.from(pair.publicKey.split(" ")[1] as string, "base64");
        const expected = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
        expect(parsed.value.fingerprint).toContain(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
