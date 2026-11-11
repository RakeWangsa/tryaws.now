import { normalizeEmail } from "@tc/core";

// The pending cookie (open point 5): where the address typed at /signup or /forgot-password is
// carried to /verify or /reset-password, so that no address is ever in a URL (R14). It is only a
// prefill: a forged cookie changes nothing but the field in the forger's own browser. The name is
// not one of the two session cookies; the app sets it through cookies().set with these attributes.

export const PENDING_COOKIE = "__Host-tc_pending";
export const PENDING_MAX_AGE_SECONDS = 1800;
const MAX_RAW_LENGTH = 512;
const FUTURE_SLACK_SECONDS = 60;

export interface Pending {
  readonly p: "signup" | "reset";
  readonly e: string;
  /** Epoch seconds of the last send. */
  readonly t: number;
}

export interface PendingCookieSpec {
  readonly name: typeof PENDING_COOKIE;
  readonly value: string;
  readonly maxAge: number;
  readonly path: "/";
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
}

export function encodePending(p: Pending): string {
  return Buffer.from(JSON.stringify({ v: 1, p: p.p, e: p.e, t: p.t }), "utf8").toString(
    "base64url",
  );
}

export function decodePending(raw: string | undefined, nowMs: number = Date.now()): Pending | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "e,p,t,v") return null;
  const { v, p, e, t } = parsed as Record<string, unknown>;
  if (v !== 1 || (p !== "signup" && p !== "reset")) return null;
  if (typeof e !== "string" || normalizeEmail(e) !== e) return null;
  if (typeof t !== "number" || !Number.isInteger(t)) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (t < nowSeconds - PENDING_MAX_AGE_SECONDS || t > nowSeconds + FUTURE_SLACK_SECONDS) {
    return null;
  }
  return { p, e, t };
}

/** The one place the attributes of the pending cookie are written down. */
export function pendingCookieSpec(value: string): PendingCookieSpec {
  return {
    name: PENDING_COOKIE,
    value,
    maxAge: PENDING_MAX_AGE_SECONDS,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  };
}

export function clearPendingCookieSpec(): PendingCookieSpec {
  return { ...pendingCookieSpec("deleted"), maxAge: 0 };
}
