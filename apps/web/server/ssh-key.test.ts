import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSshKeyInput } from "./ssh-key.ts";

// WPU-Y5 (e): an OpenSSH line from a real key made by Node, for each type the browser or a customer may bring.
function field(b: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(b.length);
  return Buffer.concat([head, b]);
}
const mpint = (b: Buffer): Buffer =>
  field((b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);

function openSshRsa(bits = 2048): string {
  const jwk = generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({
    format: "jwk",
  });
  const blob = Buffer.concat([
    field(Buffer.from("ssh-rsa")),
    mpint(Buffer.from(jwk.e as string, "base64url")),
    mpint(Buffer.from(jwk.n as string, "base64url")),
  ]);
  return `ssh-rsa ${blob.toString("base64")}`;
}

function openSshEd25519(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const blob = Buffer.concat([
    field(Buffer.from("ssh-ed25519")),
    field(der.subarray(der.length - 32)),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

describe("parseSshKeyInput", () => {
  it("accepts an OpenSSH ssh-rsa public key and computes the SHA256 fingerprint of its blob", () => {
    const key = openSshRsa();
    const parsed = parseSshKeyInput({ name: "Laptop 1", publicKey: `${key} me@host\n` });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const blob = Buffer.from(key.split(" ")[1] as string, "base64");
    const expected = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
    expect(parsed.value.fingerprint).toBe(expected);
    expect(parsed.value.publicKey).toBe(key);
    expect(parsed.value.name).toBe("Laptop 1");
  });

  it("refuses a private key and says only that the key is invalid", () => {
    const parsed = parseSshKeyInput({
      name: "k",
      publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(parsed).toEqual({ ok: false, error: "validation", fields: { publicKey: "invalid" } });
  });

  // WPU-Y5 (e): Lightsail ImportKeyPair takes ssh-rsa keys only (API reference: "a public key of the ssh-rsa type").
  it("refuses Ed25519 and ECDSA keys, and RSA keys under 2048 bits, with the one word invalid", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const point = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
    const ecdsa = `ecdsa-sha2-nistp256 ${Buffer.concat([
      field(Buffer.from("ecdsa-sha2-nistp256")),
      field(Buffer.from("nistp256")),
      field(point),
    ]).toString("base64")}`;
    for (const key of [openSshEd25519(), ecdsa, openSshRsa(1024)]) {
      expect(parseSshKeyInput({ name: "k", publicKey: key }), key.slice(0, 20)).toEqual({
        ok: false,
        error: "validation",
        fields: { publicKey: "invalid" },
      });
    }
    expect(parseSshKeyInput({ name: "k", publicKey: openSshRsa(3072) }).ok).toBe(true);
  });

  it("refuses a blob whose embedded type differs from the declared type", () => {
    const key = openSshEd25519().replace("ssh-ed25519", "ssh-rsa");
    const parsed = parseSshKeyInput({ name: "k", publicKey: key });
    expect(parsed).toEqual({ ok: false, error: "validation", fields: { publicKey: "invalid" } });
  });

  it("collects the field errors of name and key", () => {
    const parsed = parseSshKeyInput({ name: "<script>", publicKey: "" });
    expect(parsed).toEqual({
      ok: false,
      error: "validation",
      fields: { name: "invalid", publicKey: "invalid" },
    });
  });

  it("refuses non-text input", () => {
    expect(parseSshKeyInput(null).ok).toBe(false);
    expect(parseSshKeyInput({ name: 1, publicKey: {} }).ok).toBe(false);
  });
});
