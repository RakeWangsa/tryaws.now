import type { Clock } from "@tc/core";

export const ACCESS_COOKIE = "__Host-tc_at";
export const REFRESH_COOKIE = "__Host-tc_rt";
export const MAX_SET_COOKIE_BYTES = 4096;

export interface SetCookieOptions {
  readonly maxAgeSeconds: number; // integer >= 0
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt: Date;
}

// A JWT and a Cognito refresh token (a JWE of five dot-separated parts) are base64url plus ".".
// Nothing else may reach a header: no separator, no whitespace, no line break.
const VALUE = /^[A-Za-z0-9_\-.]+$/;
const MAX_VALUE_LENGTH = 4000;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";
// One fixed order, written from one list, so a test and a reader see one form. __Host- requires
// Secure and Path=/ and forbids Domain; Secure is never conditional (open point 3).
const FIXED_ATTRIBUTES = ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"] as const;
// Placeholder for a cleared cookie: a cookie is deleted by name, Path and flags, not by its value.
const CLEARED_VALUE = "deleted";

// Error texts are fixed: a value that fails a check may be a token (R14).
export function serializeSetCookie(
  name: typeof ACCESS_COOKIE | typeof REFRESH_COOKIE,
  value: string,
  o: SetCookieOptions,
): string {
  if (name !== ACCESS_COOKIE && name !== REFRESH_COOKIE)
    throw new TypeError("cookie: name is not allowed");
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VALUE_LENGTH ||
    !VALUE.test(value)
  ) {
    throw new TypeError("cookie: value is not allowed");
  }
  if (!Number.isInteger(o.maxAgeSeconds) || o.maxAgeSeconds < 0)
    throw new TypeError("cookie: Max-Age is not allowed");
  const attributes: string[] = [`Max-Age=${o.maxAgeSeconds}`];
  if (o.maxAgeSeconds === 0) attributes.push(`Expires=${EPOCH}`);
  attributes.push(...FIXED_ATTRIBUTES);
  const cookie = `${name}=${value}; ${attributes.join("; ")}`;
  if (Buffer.byteLength(cookie) > MAX_SET_COOKIE_BYTES)
    throw new TypeError("cookie: Set-Cookie is too large");
  return cookie;
}

// First occurrence wins: with __Host- there is one legitimate cookie, and a duplicate must not
// replace it silently. Values are returned as sent (tokens are never percent-encoded).
export function parseCookieHeader(header: string | null | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (typeof header !== "string" || header.length === 0) return out;
  for (const part of header.split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!COOKIE_NAME.test(name)) continue;
    if (!out.has(name)) out.set(name, pair.slice(eq + 1).trim());
  }
  return out;
}

// True when a value may be a cookie value of the session: the same check as serializeSetCookie.
export function isCookieValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    VALUE.test(value)
  );
}

// A cookie as a Server Action sets it with (await cookies()).set(spec) (WP2-T2, open point 9). The
// attributes are the fixed ones of serializeSetCookie, written as fields; nothing is optional, so a
// caller cannot weaken them. The app never names the cookie names or the attributes itself.
export interface CookieSpec {
  readonly name: typeof ACCESS_COOKIE | typeof REFRESH_COOKIE;
  readonly value: string;
  readonly maxAge: number; // seconds, integer >= 0
  readonly path: "/";
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
}

// The spec is made only after serializeSetCookie has accepted the same name, value and Max-Age, so
// the checks (value shape, length, Max-Age, total size) are one piece of code and cannot drift.
function cookieSpec(
  name: typeof ACCESS_COOKIE | typeof REFRESH_COOKIE,
  value: string,
  maxAge: number,
): CookieSpec {
  serializeSetCookie(name, value, { maxAgeSeconds: maxAge });
  return { name, value, maxAge, path: "/", httpOnly: true, secure: true, sameSite: "lax" };
}

// The admin app has its own cookie: a customer cookie is never an admin session and the other way
// round. One cookie, no refresh cookie: an admin session lives as long as the access token (8 h,
// set on the admin app client) and then the admin signs in again with TOTP (6.2).
export const ADMIN_ACCESS_COOKIE = "__Host-tc_admin_at";

function serializeAdminCookie(value: string, maxAgeSeconds: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VALUE_LENGTH ||
    !VALUE.test(value)
  ) {
    throw new TypeError("cookie: value is not allowed");
  }
  const attributes: string[] = [`Max-Age=${maxAgeSeconds}`];
  if (maxAgeSeconds === 0) attributes.push(`Expires=${EPOCH}`);
  attributes.push(...FIXED_ATTRIBUTES);
  const cookie = `${ADMIN_ACCESS_COOKIE}=${value}; ${attributes.join("; ")}`;
  if (Buffer.byteLength(cookie) > MAX_SET_COOKIE_BYTES)
    throw new TypeError("cookie: Set-Cookie is too large");
  return cookie;
}

export function adminSessionSetCookie(
  accessToken: string,
  accessExpiresAt: Date,
  clock: Clock,
): string {
  return serializeAdminCookie(accessToken, remainingSeconds(accessExpiresAt, clock));
}

export function clearAdminSessionSetCookie(): string {
  return serializeAdminCookie(CLEARED_VALUE, 0);
}

function remainingSeconds(expiresAt: Date, clock: Clock): number {
  const ms = expiresAt.getTime() - clock.now().getTime();
  // floor: the cookie must not outlive the token. NaN (an invalid Date) gives 0.
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

export function sessionSetCookies(
  t: SessionTokens,
  clock: Clock,
  refreshMaxAgeSeconds = 2_592_000,
): string[] {
  const cookies = [
    serializeSetCookie(ACCESS_COOKIE, t.accessToken, {
      maxAgeSeconds: remainingSeconds(t.accessExpiresAt, clock),
    }),
  ];
  if (t.refreshToken !== undefined) {
    cookies.push(
      serializeSetCookie(REFRESH_COOKIE, t.refreshToken, { maxAgeSeconds: refreshMaxAgeSeconds }),
    );
  }
  return cookies;
}

// Same cookies, same names, same order and same Max-Age as sessionSetCookies, as specs.
export function sessionCookieSpecs(
  t: SessionTokens,
  clock: Clock,
  refreshMaxAgeSeconds = 2_592_000,
): CookieSpec[] {
  const specs = [
    cookieSpec(ACCESS_COOKIE, t.accessToken, remainingSeconds(t.accessExpiresAt, clock)),
  ];
  if (t.refreshToken !== undefined) {
    specs.push(cookieSpec(REFRESH_COOKIE, t.refreshToken, refreshMaxAgeSeconds));
  }
  return specs;
}

export function clearCookieSpecs(): CookieSpec[] {
  return [
    cookieSpec(ACCESS_COOKIE, CLEARED_VALUE, 0),
    cookieSpec(REFRESH_COOKIE, CLEARED_VALUE, 0),
  ];
}

export function clearSessionSetCookies(): string[] {
  return [
    serializeSetCookie(ACCESS_COOKIE, CLEARED_VALUE, { maxAgeSeconds: 0 }),
    serializeSetCookie(REFRESH_COOKIE, CLEARED_VALUE, { maxAgeSeconds: 0 }),
  ];
}

// proxy.ts forwards the refreshed access token to the rendering of the same request; the response
// cookie reaches the browser only afterwards. Other cookies pass through untouched.
export function withSessionCookies(header: string | null | undefined, t: SessionTokens): string {
  const replaced = new Set<string>([ACCESS_COOKIE]);
  if (t.refreshToken !== undefined) replaced.add(REFRESH_COOKIE);
  const kept: string[] = [];
  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const pair = part.trim();
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      if (!replaced.has(pair.slice(0, eq).trim())) kept.push(pair);
    }
  }
  // Same checks as a Set-Cookie value, so a bad token cannot be smuggled into the header.
  for (const [name, value] of [
    [ACCESS_COOKIE, t.accessToken],
    [REFRESH_COOKIE, t.refreshToken],
  ] as const) {
    if (value === undefined) continue;
    if (value.length === 0 || value.length > MAX_VALUE_LENGTH || !VALUE.test(value)) {
      throw new TypeError("cookie: value is not allowed");
    }
    kept.push(`${name}=${value}`);
  }
  return kept.join("; ");
}
