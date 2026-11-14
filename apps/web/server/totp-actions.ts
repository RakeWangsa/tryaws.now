import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession, TotpPort } from "@tc/auth";
import { parseOtpCode } from "@tc/core";
import type { AuditRepo, CustomerLimit, ProfileRepo, RateLimitsRepo } from "@tc/db";

// WPU-X11 (owner decision 2026-11-14): the customer's authenticator (TOTP), one of the three steps of the
// account setup that replaced KYC as the buy condition. The cores of the three actions of
// /settings/security. R9 order in each: authenticate (with the fresh sign-in of 6.1 / U10), validate,
// rate limit, execute (Cognito through the port, with the customer's own access token), audit.
//
// The stored fact is customers.totp_enabled_at. It is set only after Cognito accepted the code
// (VerifySoftwareToken) AND saved the preference (SetUserMFAPreference), and cleared after Cognito
// switched TOTP off. The secret is returned once to the Server Action (U9) and is never stored, logged,
// audited or part of an error; neither is a code or the access token (R14).

export interface TotpRepos {
  profile: ProfileRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

export interface TotpDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: TotpRepos) => Promise<T>): Promise<T>;
  /** null = not configured: every action refuses (R16). */
  totp: TotpPort | null;
  /** The access token of this request's session cookie; null when there is none. */
  accessToken(): string | null;
}

export type TotpError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "invalid_code"
  | "unavailable";

export type TotpFailure = { ok: false; error: TotpError; fields?: Record<string, string> };
export type TotpResult<T extends object = object> = ({ ok: true } & T) | TotpFailure;

// Ten tries an hour cover a start, a few mistyped codes and a confirm; more is an attack on the code.
export const TOTP_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.totp", limit: 10, windowSeconds: 3600 }),
]);

const ISSUER = "TryAWS.now";

/**
 * The otpauth URI that an authenticator app reads (Key Uri Format). The label is the issuer only: the
 * customer's e-mail is not put into a link or a QR code.
 */
export function otpauthUri(secret: string): string {
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${issuer}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

const fail = (error: TotpError, fields?: Record<string, string>): TotpFailure => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

async function guard(
  deps: TotpDeps,
): Promise<{ session: CustomerSession; port: TotpPort; token: string } | TotpFailure> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  if (!requireFreshSignIn(session, { now: deps.now }).ok) return fail("fresh_sign_in_required");
  if (deps.totp === null) return fail("unavailable");
  const token = deps.accessToken();
  if (token === null || token === "") return fail("unauthenticated");
  return { session, port: deps.totp, token };
}

async function audit(repos: TotpRepos, action: string): Promise<void> {
  const written = await repos.audit.record({ action, targetType: "customer" });
  if (!written.ok) throw new Error("totp: the audit entry was refused");
}

/** Maps a failure of the port to a public error; nothing of its text is kept. */
function portFailure(kind: string): TotpFailure {
  switch (kind) {
    case "invalid_code":
      return fail("invalid_code", { code: "wrong" });
    case "denied":
      return fail("unauthenticated");
    case "rate_limited":
      return fail("rate_limited");
    default:
      return fail("unavailable");
  }
}

/** Step 1: a new secret, shown once. Refused when the authenticator is already on. */
export async function startTotpCore(
  deps: TotpDeps,
): Promise<TotpResult<{ secret: string; otpauthUri: string }>> {
  const guarded = await guard(deps);
  if (!("session" in guarded)) return guarded;
  const { session, port, token } = guarded;
  try {
    const gate = await deps.store(session.customerId, async (repos) => {
      const profile = await repos.profile.get();
      if (profile === null) return "unavailable" as const;
      if (profile.totpEnabledAt !== null) return "already_on" as const;
      const limit = await repos.rateLimits.consume(TOTP_LIMITS, deps.now());
      return limit.allowed ? ("ok" as const) : ("rate_limited" as const);
    });
    if (gate === "already_on") return fail("validation", { totp: "already_on" });
    if (gate !== "ok") return fail(gate);

    const associated = await port.associate(token);
    if (!associated.ok) return portFailure(associated.kind);
    await deps.store(session.customerId, (repos) => audit(repos, "auth.totp_setup_started"));
    const { secret } = associated.value;
    return { ok: true, secret, otpauthUri: otpauthUri(secret) };
  } catch {
    return fail("unavailable");
  }
}

/** Step 2: the 6-digit code from the app. On success TOTP is on at Cognito and stored as on. */
export async function confirmTotpCore(deps: TotpDeps, raw: unknown): Promise<TotpResult> {
  const guarded = await guard(deps);
  if (!("session" in guarded)) return guarded;
  const { session, port, token } = guarded;

  const rawCode = record(raw)["code"];
  const code = typeof rawCode === "string" ? parseOtpCode(rawCode) : null;
  if (code === null) return fail("validation", { code: "malformed" });

  try {
    const allowed = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(TOTP_LIMITS, deps.now());
      return limit.allowed;
    });
    if (!allowed) return fail("rate_limited");

    const verified = await port.verify(token, code);
    if (!verified.ok) return portFailure(verified.kind);
    const enabled = await port.setPreference(token, true);
    if (!enabled.ok) return portFailure(enabled.kind);

    return await deps.store(session.customerId, async (repos): Promise<TotpResult> => {
      const saved = await repos.profile.setTotpEnabled(deps.now());
      if (!saved.ok) return fail("unavailable");
      await audit(repos, "auth.totp_enabled");
      return { ok: true };
    });
  } catch {
    return fail("unavailable");
  }
}

/** Switches the authenticator off (fresh sign-in). Buying is blocked again until it is on. */
export async function disableTotpCore(deps: TotpDeps): Promise<TotpResult> {
  const guarded = await guard(deps);
  if (!("session" in guarded)) return guarded;
  const { session, port, token } = guarded;
  try {
    const gate = await deps.store(session.customerId, async (repos) => {
      const profile = await repos.profile.get();
      if (profile === null) return "unavailable" as const;
      if (profile.totpEnabledAt === null) return "not_on" as const;
      const limit = await repos.rateLimits.consume(TOTP_LIMITS, deps.now());
      return limit.allowed ? ("ok" as const) : ("rate_limited" as const);
    });
    if (gate === "not_on") return fail("validation", { totp: "not_on" });
    if (gate !== "ok") return fail(gate);

    const disabled = await port.setPreference(token, false);
    if (!disabled.ok) return portFailure(disabled.kind);
    return await deps.store(session.customerId, async (repos): Promise<TotpResult> => {
      const saved = await repos.profile.setTotpEnabled(null);
      if (!saved.ok) return fail("unavailable");
      await audit(repos, "auth.totp_disabled");
      return { ok: true };
    });
  } catch {
    return fail("unavailable");
  }
}
