import { createHash } from "node:crypto";
import { isImportableSshKey, type Result } from "@tc/core";

// An SSH public key typed or pasted by the customer. Public keys only: anything else, a private key
// above all, is refused with the one word "invalid" and is never echoed (R14, U9). The fingerprint is
// the OpenSSH one (SHA-256 of the key blob, base64 without padding); Node's own hash, no dependency.

export interface ParsedSshKey {
  readonly name: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

const NAME = /^[A-Za-z0-9 ._-]{1,60}$/;
// WPU-Y5 (e): only ssh-rsa, of 2048 to 16384 bits (isImportableSshKey of @tc/core). Lightsail ImportKeyPair
// documents publicKeyBase64 as "a base64-encoded public key of the ssh-rsa type" and no Lightsail page documents
// Ed25519 or ECDSA (docs/analysis/verify-review-2026-11-13.md), so a key of another type could not start a server.
const TYPES = ["ssh-rsa"] as const;
const MAX_KEY_TEXT = 8192;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The type string that opens the blob (a 4 byte length, then the text). */
function blobType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length < 1 || length > 64 || blob.length < 4 + length) return null;
  return blob.subarray(4, 4 + length).toString("latin1");
}

export function parseSshKeyInput(input: unknown): Result<ParsedSshKey> {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const fields: Record<string, string> = {};
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (!NAME.test(name)) fields["name"] = "invalid";

  const text = record["publicKey"];
  let key: { type: string; data: string } | null = null;
  if (typeof text === "string" && text.length <= MAX_KEY_TEXT) {
    // One line: the type, the base64 blob, an optional comment that is dropped.
    const parts = text.trim().split(/\s+/);
    const [type, data] = parts;
    if (
      !text.includes("PRIVATE") &&
      type !== undefined &&
      data !== undefined &&
      (TYPES as readonly string[]).includes(type) &&
      BASE64.test(data) &&
      !text.trim().includes("\n")
    ) {
      key = { type, data };
    }
  }
  let fingerprint = "";
  if (key !== null) {
    const blob = Buffer.from(key.data, "base64");
    if (
      blobType(blob) !== key.type ||
      blob.length > 4096 ||
      !isImportableSshKey(`${key.type} ${key.data}`)
    )
      key = null;
    else
      fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  }
  if (key === null) fields["publicKey"] = "invalid";

  if (Object.keys(fields).length > 0 || key === null) {
    return { ok: false, error: "validation", fields };
  }
  return {
    ok: true,
    value: { name, publicKey: `${key.type} ${key.data}`, fingerprint },
  };
}
