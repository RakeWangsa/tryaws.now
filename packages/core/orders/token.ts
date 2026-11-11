import { createHmac, timingSafeEqual } from "node:crypto";
import { parseSnapshot } from "../pricing/index";
import { DRAFT_MAX_BYTES, DRAFT_TTL_SECONDS, type DraftClaims } from "./types";

const MIN_SECRET_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_KEYS = ["v", "c", "fam", "pid", "region", "cfg", "snap", "iat", "exp"] as const;
const MAC_LENGTH = 43; // base64url of 32 bytes, no padding

export type DraftVerdict =
  { ok: true; claims: DraftClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Refuses an empty list and any key under 32 bytes. The text holds nothing about the key. */
export function assertSecrets(secrets: readonly Uint8Array[]): void {
  if (secrets.length === 0 || secrets.some((s) => s.length < MIN_SECRET_BYTES)) {
    throw new TypeError("orders: the draft secret is missing or too short");
  }
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
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((k) => Object.hasOwn(raw, k))) {
    return null;
  }
  const { v, c, fam, pid, region, cfg, snap, iat, exp } = raw;
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
  return { v: 1, c, fam, pid, region, cfg, snap: snapshot, iat: issued, exp: expires };
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
  if (now.getTime() / 1000 >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
