import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession, IdpResult } from "@tc/auth";
import {
  checkPassword,
  normalizeBdMobile,
  normalizeDisplayName,
  normalizeEmail,
  parseOtpCode,
} from "@tc/core";
import type { Result } from "@tc/core";
import type { AuditRepo, CustomerLimit, ProfileRepo, RateLimitsRepo } from "@tc/db";
import type { OtpSent, OtpVerified } from "@tc/notify";

// The cores of the actions of /settings/profile and /settings/security (WP2-T5). R9 order in each:
// authenticate, authorize (a fresh sign-in, 6.1, for every change of e-mail, phone or password),
// validate, rate limit, execute, audit. The ports are parameters, so the cores run in a test without
// a database, Cognito or an SMS gateway. No password, code, e-mail address or phone number is in an
// audit entry, a log line or an error answer (R14).

export interface SettingsRepos {
  profile: ProfileRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

/**
 * What the identity provider does for the signed-in customer. A local port: the IdentityProvider of
 * @tc/auth (a contract of WP2-T2) has sign-up, sign-in and reset only, and is not changed here. The
 * Cognito adapter (ChangePassword, UpdateUserAttributes, VerifyUserAttribute) is a manual VERIFY of
 * the staging deploy; until then the real runtime has no AccountPort and the actions refuse (R16).
 */
export interface AccountPort {
  changePassword(i: {
    customerId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<IdpResult<true>>;
  /** The provider sends a code to the new address; the address in the profile stays as it is. */
  startEmailChange(i: { customerId: string; newEmail: string }): Promise<IdpResult<true>>;
  confirmEmailChange(i: {
    customerId: string;
    newEmail: string;
    code: string;
  }): Promise<IdpResult<true>>;
}

/** The phone OTP service of @tc/notify (sendPhoneOtp, verifyPhoneOtp) with its dependencies bound. */
export interface PhoneOtpPort {
  send(
    session: CustomerSession,
    input: { phone: string; ip: string; idempotencyKey: string },
  ): Promise<Result<OtpSent>>;
  verify(session: CustomerSession, input: { code: string }): Promise<Result<OtpVerified>>;
}

export interface AccountPorts {
  account: AccountPort;
  otp: PhoneOtpPort;
}

export interface SettingsDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: SettingsRepos) => Promise<T>): Promise<T>;
  /** null = not configured: the actions that need it refuse (R16). */
  ports: AccountPorts | null;
  /** The address of the request, for the per-IP limit of the OTP service. */
  clientIp(): string;
}

export type SettingsError =
  | "unauthenticated"
  | "forbidden"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "wrong_password"
  | "invalid_code"
  | "expired_code"
  | "unavailable";

export type SettingsFailure = {
  ok: false;
  error: SettingsError;
  fields?: Record<string, string>;
  retryAfterSeconds?: number;
};
export type SettingsResult<T extends object = object> = ({ ok: true } & T) | SettingsFailure;

const PROFILE_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.profile", limit: 20, windowSeconds: 3600 }),
]);
const EMAIL_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.email", limit: 6, windowSeconds: 3600 }),
]);
const PASSWORD_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "settings.password", limit: 5, windowSeconds: 3600 }),
]);
// The same shape as the key of the OTP service (policy.ts OTP_IDEMPOTENCY_KEY).
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
const fail = (error: SettingsError, fields?: Record<string, string>): SettingsFailure => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

/** Authenticate, and for a sensitive change the fresh sign-in of 6.1. */
async function guard(
  deps: SettingsDeps,
  fresh: boolean,
): Promise<{ session: CustomerSession } | SettingsFailure> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  if (fresh && !requireFreshSignIn(session, { now: deps.now }).ok) {
    return fail("fresh_sign_in_required");
  }
  return { session };
}

async function audit(
  repos: SettingsRepos,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const written = await repos.audit.record({
    action,
    targetType: "customer",
    ...(metadata ? { metadata } : {}),
  });
  if (!written.ok) throw new Error("settings: the audit entry was refused");
}

/** Maps a failure of the identity provider to a public error; nothing of its text is kept. */
function idpFailure(kind: string): SettingsFailure {
  switch (kind) {
    case "invalid_password":
    case "denied":
      return fail("wrong_password", { currentPassword: "wrong" });
    case "invalid_code":
      return fail("invalid_code", { code: "wrong" });
    case "expired_code":
      return fail("expired_code", { code: "expired" });
    case "rate_limited":
      return fail("rate_limited");
    default:
      return fail("unavailable");
  }
}

export async function updateProfileCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult<{ locale: "bn" | "en" }>> {
  const guarded = await guard(deps, false);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const input = record(raw);
  const name = normalizeDisplayName(input["name"]);
  const locale = input["locale"];
  const fields: Record<string, string> = {};
  if (name === null) fields["name"] = "invalid";
  if (locale !== "bn" && locale !== "en") fields["locale"] = "invalid";
  if (name === null || (locale !== "bn" && locale !== "en")) return fail("validation", fields);

  try {
    return await deps.store(
      session.customerId,
      async (repos): Promise<SettingsResult<{ locale: "bn" | "en" }>> => {
        const limit = await repos.rateLimits.consume(PROFILE_LIMITS, deps.now());
        if (!limit.allowed) return fail("rate_limited");
        const saved = await repos.profile.update({ name, locale });
        if (!saved.ok) return fail("unavailable");
        // The entry says which fields changed, never their values.
        await audit(repos, "profile.updated", { fields: ["name", "locale"] });
        return { ok: true, locale };
      },
    );
  } catch {
    return fail("unavailable");
  }
}

export async function startEmailChangeCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult<{ sentTo: "new_address" }>> {
  const guarded = await guard(deps, true);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const email = normalizeEmail(record(raw)["email"]);
  if (email === null) return fail("validation", { email: "invalid" });
  if (deps.ports === null) return fail("unavailable");
  const { account } = deps.ports;

  try {
    const gate = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(EMAIL_LIMITS, deps.now());
      if (!limit.allowed) return "rate_limited" as const;
      const profile = await repos.profile.get();
      if (profile === null) return "unavailable" as const;
      // The same address is no change.
      if (profile.email.toLowerCase() === email) return "same" as const;
      return "ok" as const;
    });
    if (gate === "rate_limited") return fail("rate_limited");
    if (gate === "unavailable") return fail("unavailable");
    if (gate === "same") return fail("validation", { email: "same" });

    const sent = await account.startEmailChange({
      customerId: session.customerId,
      newEmail: email,
    });
    if (!sent.ok) return idpFailure(sent.kind);
    await deps.store(session.customerId, (repos) => audit(repos, "profile.email_change_started"));
    return { ok: true, sentTo: "new_address" };
  } catch {
    return fail("unavailable");
  }
}

export async function confirmEmailChangeCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult> {
  const guarded = await guard(deps, true);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const input = record(raw);
  const email = normalizeEmail(input["email"]);
  const rawCode = input["code"];
  const code = typeof rawCode === "string" ? parseOtpCode(rawCode) : null;
  const fields: Record<string, string> = {};
  if (email === null) fields["email"] = "invalid";
  if (code === null) fields["code"] = "malformed";
  if (email === null || code === null) return fail("validation", fields);
  if (deps.ports === null) return fail("unavailable");
  const { account } = deps.ports;

  try {
    const allowed = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(EMAIL_LIMITS, deps.now());
      return limit.allowed;
    });
    if (!allowed) return fail("rate_limited");

    const confirmed = await account.confirmEmailChange({
      customerId: session.customerId,
      newEmail: email,
      code,
    });
    if (!confirmed.ok) return idpFailure(confirmed.kind);

    return await deps.store(session.customerId, async (repos): Promise<SettingsResult> => {
      const saved = await repos.profile.setEmail(email);
      if (!saved.ok) return fail("unavailable");
      await audit(repos, "profile.email_changed");
      return { ok: true };
    });
  } catch {
    return fail("unavailable");
  }
}

export async function changePasswordCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult> {
  const guarded = await guard(deps, true);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const input = record(raw);
  const current = input["currentPassword"];
  const next = input["newPassword"];
  const confirm = input["confirmPassword"];
  const fields: Record<string, string> = {};
  if (typeof current !== "string" || current === "" || current.length > 1024) {
    fields["currentPassword"] = "required";
  }
  if (deps.ports === null) return fail("unavailable");
  const { account } = deps.ports;

  try {
    // The address is read only to refuse a password equal to it (checkPassword); it goes nowhere else.
    const email = await deps.store(session.customerId, async (repos) => {
      const profile = await repos.profile.get();
      return profile === null ? null : profile.email;
    });
    if (email === null) return fail("unavailable");

    const strength = checkPassword(next, email);
    if (!strength.ok) fields["newPassword"] = strength.issue;
    else if (next === current) fields["newPassword"] = "same_as_current";
    else if (confirm !== next) fields["confirmPassword"] = "mismatch";
    if (Object.keys(fields).length > 0) return fail("validation", fields);

    const allowed = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(PASSWORD_LIMITS, deps.now());
      return limit.allowed;
    });
    if (!allowed) return fail("rate_limited");

    const changed = await account.changePassword({
      customerId: session.customerId,
      currentPassword: current as string,
      newPassword: next as string,
    });
    if (!changed.ok) return idpFailure(changed.kind);
    await deps.store(session.customerId, (repos) => audit(repos, "auth.password_changed"));
    return { ok: true };
  } catch {
    return fail("unavailable");
  }
}

function otpFailure(result: Extract<Result<unknown>, { ok: false }>): SettingsFailure {
  switch (result.error) {
    case "validation":
      return fail(
        result.fields?.["code"] === "wrong" ? "invalid_code" : "validation",
        result.fields,
      );
    case "rate_limited":
    case "limit_reached":
      return {
        ...fail("rate_limited"),
        ...(typeof (result.data as { retryAfterSeconds?: unknown } | undefined)
          ?.retryAfterSeconds === "number"
          ? { retryAfterSeconds: (result.data as { retryAfterSeconds: number }).retryAfterSeconds }
          : {}),
      };
    case "not_found":
      return fail("expired_code", { code: "expired" });
    default:
      return fail("unavailable");
  }
}

export async function startPhoneChangeCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult<{ phoneMasked: string; resendAt: string }>> {
  const guarded = await guard(deps, true);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const input = record(raw);
  const phone = typeof input["phone"] === "string" ? normalizeBdMobile(input["phone"]) : null;
  const key = input["idempotencyKey"];
  const fields: Record<string, string> = {};
  if (phone === null) fields["phone"] = "invalid";
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) fields["idempotencyKey"] = "invalid";
  if (phone === null || typeof key !== "string" || fields["idempotencyKey"] !== undefined) {
    return fail("validation", fields);
  }
  if (deps.ports === null) return fail("unavailable");

  try {
    // The OTP service applies its own limits (3 sends an hour per number and per address, 1 a minute).
    const sent = await deps.ports.otp.send(session, {
      phone,
      ip: deps.clientIp(),
      idempotencyKey: key,
    });
    if (!sent.ok) return otpFailure(sent);
    await deps.store(session.customerId, (repos) => audit(repos, "profile.phone_change_started"));
    return {
      ok: true,
      phoneMasked: sent.value.phoneMasked,
      resendAt: sent.value.resendAt.toISOString(),
    };
  } catch {
    return fail("unavailable");
  }
}

export async function confirmPhoneChangeCore(
  deps: SettingsDeps,
  raw: unknown,
): Promise<SettingsResult<{ phoneMasked: string }>> {
  const guarded = await guard(deps, true);
  if (!("session" in guarded)) return guarded;
  const { session } = guarded;

  const rawCode = record(raw)["code"];
  const code = typeof rawCode === "string" ? parseOtpCode(rawCode) : null;
  if (code === null) return fail("validation", { code: "malformed" });
  if (deps.ports === null) return fail("unavailable");

  try {
    // On success the service has stored the verified number and closed the challenge.
    const verified = await deps.ports.otp.verify(session, { code });
    if (!verified.ok) return otpFailure(verified);
    await deps.store(session.customerId, (repos) => audit(repos, "profile.phone_changed"));
    return { ok: true, phoneMasked: verified.value.phoneMasked };
  } catch {
    return fail("unavailable");
  }
}
