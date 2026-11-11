import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSshKeyInput } from "./ssh-key.ts";

function openSshEd25519(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const type = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, raw.length]),
    raw,
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

describe("parseSshKeyInput", () => {
  it("accepts an OpenSSH public key and computes the SHA256 fingerprint of its blob", () => {
    const key = openSshEd25519();
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
