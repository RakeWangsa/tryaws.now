import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Orders } from "@tc/core";

// WPU-X10 review fix 3 (U6). The draft token of core is signed, not encrypted: whoever holds it can read its claims.
// The config of a domain draft holds the KMS ciphertext of the registrant contact, and a KMS ciphertext carries the
// ARN of its key, so the AWS account id. The browser must never see either. So the web tier hands out only an
// envelope of the token, AES-256-GCM with a key derived (HKDF-SHA-256) from the OrderDraftSecret it already holds,
// and opens it again before core reads the token. Core, the token format, the idempotency keys built from the token
// text and the contract of Section F are unchanged: core only ever sees its own signed token.
//
// Why this option: the draft writes no row (16.11 step 2), so there is no server-side store to keep the sealed
// contact in; this is one module around the orders port and the two places that read a token (review page, the fx
// date of a fresh draft). Every family's token is wrapped, not only the domain's (one rule, nothing to choose).
// R17: node:crypto only, no new dependency. The envelope is authenticated (GCM tag, fixed AAD); a changed or foreign
// envelope does not open and is refused as an invalid token (R16).
//
// A text without the prefix passes through unchanged: only the server ever held a plain token, and the HMAC of core
// still decides whether it is genuine.

const PREFIX = "e1.";
const AAD = Buffer.from("tc-draft-envelope-v1", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** The longest envelope: one of a signed draft of DRAFT_MAX_BYTES (4096), with the prefix, IV and tag. */
export const MAX_ENVELOPED_TOKEN = 5600;

function keyOf(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "tc-draft-envelope", "v1", 32));
}

/** The envelope of a signed draft token. The first secret of the rotation list seals. */
export function sealDraftToken(secrets: readonly Uint8Array[], token: string): string {
  const secret = secrets[0];
  if (secret === undefined) throw new TypeError("draft-envelope: no secret");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The signed token inside an envelope (any secret of the list), a plain text unchanged, or null when refused. */
export function openDraftToken(secrets: readonly Uint8Array[], text: string): string | null {
  if (typeof text !== "string") return null;
  if (!text.startsWith(PREFIX)) return text;
  if (text.length > MAX_ENVELOPED_TOKEN) return null;
  const encoded = text.slice(PREFIX.length);
  if (!B64URL.test(encoded)) return null;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      // not this secret: try the next one of the rotation list
    }
  }
  return null;
}

function hasDraftToken(value: unknown): value is { token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { token?: unknown }).token === "string"
  );
}

/** The orders port of the web tier: tokens leave as envelopes and come back opened. */
export function envelopeOrders(orders: Orders, secrets: readonly Uint8Array[]): Orders {
  return {
    async createOrderDraft(s, input) {
      const result = await orders.createOrderDraft(s, input);
      if (!result.ok) return result;
      return {
        ok: true,
        value: { ...result.value, token: sealDraftToken(secrets, result.value.token) },
      };
    },
    async placeOrder(s, input) {
      const token = openDraftToken(secrets, input.token);
      if (token === null) return { ok: false, error: "validation", fields: { token: "invalid" } };
      const result = await orders.placeOrder(s, { ...input, token });
      // price_changed carries a fresh draft: it leaves as an envelope too.
      if (!result.ok && hasDraftToken(result.data)) {
        return {
          ...result,
          data: { ...result.data, token: sealDraftToken(secrets, result.data.token) },
        };
      }
      return result;
    },
  };
}
