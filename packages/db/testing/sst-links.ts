// Test code only (WPU-Z15): linked resources in the form SST 4.17.2 hands them to a deployed function.
// The links are one JSON object (name -> properties), encrypted with AES-256-GCM under a random 32-byte
// key and a nonce of 12 zero bytes, and stored as the ciphertext followed by the 16-byte tag. SST_KEY
// holds the key in base64 and SST_KEY_FILE the path of the file; the SDK's Resource decrypts it so
// (node_modules/sst/dist/resource/node.js). The key and the file live for one test file: `remove`.
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SealedSstLinks {
  readonly env: { readonly SST_KEY: string; readonly SST_KEY_FILE: string };
  readonly remove: () => void;
}

export function sealSstLinks(links: Readonly<Record<string, unknown>>): SealedSstLinks {
  const key = randomBytes(32);
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12, 0));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(links), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "tc-sst-links-"));
  const file = join(dir, "resource.enc");
  writeFileSync(file, sealed);
  return {
    env: { SST_KEY: key.toString("base64"), SST_KEY_FILE: file },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
