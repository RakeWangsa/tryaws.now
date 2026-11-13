import { createHmac, timingSafeEqual } from "node:crypto";
import { parseSnapshot } from "../pricing/index";
import { DRAFT_MAX_BYTES, DRAFT_TTL_SECONDS, type DraftClaims } from "./types";

const MIN_SECRET_BYTES = 32;
// A rotation list: the signing key and at most two older ones. A longer list only widens what may forge a draft.
const MAX_SECRETS = 3;
const B64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_KEYS = ["v", "c", "fam", "pid", "region", "cfg", "snap", "iat", "exp"] as const;
const MAC_LENGTH = 43; // base64url of 32 bytes, no padding

export type DraftVerdict =
  | { ok: true; claims: DraftClaims }
  | { ok: false; reason: "malformed" | "signature" }
  // A signed draft past its expiry: the claims are carried so a replay of its order can be answered.
  | { ok: false; reason: "expired"; claims?: DraftClaims };

/** Refuses an empty list, more than three keys and any key under 32 bytes. The text holds nothing about the key. */
export function assertSecrets(secrets: readonly Uint8Array[]): void {
  if (secrets.length === 0 || secrets.some((s) => s.length < MIN_SECRET_BYTES)) {
    throw new TypeError("orders: the draft secret is missing or too short");
  }
  if (secrets.length > MAX_SECRETS) throw new TypeError("orders: too many draft secrets");
}

function mac(secret: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** `base64url(JSON claims) + "." + base64url(HMAC-SHA-256)`. The first secret signs. */
export function signDraft(secrets: readonly Uint8Array[], claims: DraftClaims): string {
  assertSecrets(secrets);
  const ordered = {
    v: claims.v,
    c: claims.c,
    fam: claims.fam,
    pid: claims.pid,
    region: claims.region,
    cfg: claims.cfg,
    snap: claims.snap,
    // WPU-Y4: after snap and only when present, so a draft without a rate row signs as before.
    ...(claims.fx === undefined ? {} : { fx: claims.fx }),
    iat: claims.iat,
    exp: claims.exp,
  };
  const payload = Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
  return `${payload}.${mac(secrets[0] as Uint8Array, payload).toString("base64url")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/** The hand-written shape check of the claims (no zod in core, open point 3). Null when refused. */
function readClaims(raw: unknown): DraftClaims | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  const withFx = Object.hasOwn(raw, "fx");
  if (
    keys.length !== CLAIM_KEYS.length + (withFx ? 1 : 0) ||
    !CLAIM_KEYS.every((k) => Object.hasOwn(raw, k))
  ) {
    return null;
  }
  const { v, c, fam, pid, region, cfg, snap, iat, exp, fx } = raw;
  let rate: { id: string; at: string } | undefined;
  if (withFx) {
    if (!isRecord(fx) || Object.keys(fx).length !== 2) return null;
    const { id, at } = fx as Record<string, unknown>;
    if (
      !boundedText(id) ||
      typeof at !== "string" ||
      Number.isNaN(new Date(at).getTime()) ||
      new Date(at).toISOString() !== at
    ) {
      return null;
    }
    rate = { id, at };
  }
  if (v !== 1) return null;
  if (typeof c !== "string" || !UUID.test(c)) return null;
  if (!boundedText(fam) || !boundedText(pid) || !boundedText(region)) return null;
  if (!isRecord(cfg)) return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  const issued = iat as number;
  const expires = exp as number;
  if (expires <= issued || expires - issued > DRAFT_TTL_SECONDS) return null;
  let snapshot;
  try {
    snapshot = parseSnapshot(snap);
  } catch {
    return null;
  }
  return {
    v: 1,
    c,
    fam,
    pid,
    region,
    cfg,
    snap: snapshot,
    ...(rate === undefined ? {} : { fx: rate }),
    iat: issued,
    exp: expires,
  };
}

/**
 * Checks size, then the mac against every listed secret (constant time), then the claims, then the
 * expiry. A verdict never holds the token.
 */
export function verifyDraft(
  secrets: readonly Uint8Array[],
  token: string,
  now: Date,
): DraftVerdict {
  assertSecrets(secrets);
  if (typeof token !== "string" || token.length > DRAFT_MAX_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, given] = parts as [string, string];
  if (!B64URL.test(payload) || !B64URL.test(given) || given.length !== MAC_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const givenBytes = Buffer.from(given, "base64url");
  // 43 characters carry 258 bits for a 256-bit mac: the last character has two spare bits, so four texts
  // decode to the same mac. The ledger key and the order id are built from the token text, so only the
  // canonical text is accepted; otherwise one draft could be submitted as four orders.
  if (givenBytes.toString("base64url") !== given) return { ok: false, reason: "malformed" };
  let signed = false;
  for (const secret of secrets) {
    const expected = mac(secret, payload);
    if (expected.length === givenBytes.length && timingSafeEqual(expected, givenBytes)) {
      signed = true;
    }
  }
  if (!signed) return { ok: false, reason: "signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claims = readClaims(parsed);
  if (claims === null) return { ok: false, reason: "malformed" };
  if (now.getTime() / 1000 >= claims.exp) return { ok: false, reason: "expired", claims };
  return { ok: true, claims };
}
