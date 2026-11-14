import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, CustomerProfile, ProfileRepo, RateLimitsRepo } from "@tc/db";
import { describe, expect, it } from "vitest";
import { DEV_CODE, DEV_PASSWORD, FakeAccount, FakePhoneOtp } from "./fakes/account-fakes.ts";
import {
  changePasswordCore,
  confirmEmailChangeCore,
  confirmPhoneChangeCore,
  startEmailChangeCore,
  startPhoneChangeCore,
  updateProfileCore,
  type SettingsDeps,
  type SettingsRepos,
} from "./settings-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OLD_EMAIL = "old@example.test";
const NEW_EMAIL = "new@example.test";
const NEW_PASSWORD = "a-very-good-new-passphrase";

const session = (signedInAt: Date): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "none",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 11 * 60_000);

function world(over: { signedInAt?: Date; limited?: boolean; noPorts?: boolean } = {}) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const account = new FakeAccount();
  const otp = new FakePhoneOtp();
  const profile = { id: CUSTOMER, email: OLD_EMAIL } as CustomerProfile;
  const repos: SettingsRepos = {
    profile: {
      get: async () => profile,
      update: async (input) => {
        calls.push("profile.update");
        logged.push(input);
        return { ok: true, replayed: false, value: profile };
      },
      setEmail: async (email) => {
        calls.push("profile.setEmail");
        logged.push(email);
        return { ok: true, replayed: false, value: { ...profile, email } };
      },
      setVerifiedPhone: async () => ({ ok: false, error: "forbidden" }),
      getBilling: async () => null,
      getBuyerSource: async () => null,
      setBilling: async () => ({ ok: false, error: "forbidden" }),
      markEmailVerified: async () => ({ ok: false, error: "forbidden" }),
      setTotpEnabled: async () => ({ ok: false, error: "forbidden" }),
      revokeSessions: async () => ({ ok: false, error: "forbidden" }),
    } satisfies ProfileRepo,
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}`);
        logged.push(input);
        return { ok: true, replayed: false, value: { id: "a" } };
      },
    } satisfies AuditRepo,
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.limited === true
          ? { allowed: false, action: "x", retryAfterSeconds: 9 }
          : { allowed: true };
      },
    } satisfies RateLimitsRepo,
  };
  let current: CustomerSession | null = session(over.signedInAt ?? FRESH);
  const deps: SettingsDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      expect(customerId).toBe(CUSTOMER);
      return fn(repos);
    },
    ports: over.noPorts === true ? null : { account, otp },
    clientIp: () => "203.0.113.7",
  };
  return {
    deps,
    calls,
    logged,
    account,
    otp,
    setSession: (s: CustomerSession | null) => {
      current = s;
    },
  };
}

describe("updateProfileCore", () => {
  it("authenticates, validates, rate limits, writes and audits, in that order", async () => {
    const w = world();
    const r = await updateProfileCore(w.deps, { name: "করিম রহমান", locale: "bn" });
    expect(r).toEqual({ ok: true, locale: "bn" });
    expect(w.calls).toEqual([
      "authenticate",
      "rateLimit",
      "profile.update",
      "audit:profile.updated",
    ]);
  });
  it("needs no fresh sign-in, refuses bad input before the database, keeps names out of the audit", async () => {
    const w = world({ signedInAt: STALE });
    expect(await updateProfileCore(w.deps, { name: "x", locale: "fr" })).toEqual({
      ok: false,
      error: "validation",
      fields: { name: "invalid", locale: "invalid" },
    });
    expect(w.calls).toEqual(["authenticate"]);
    await updateProfileCore(w.deps, { name: "Karim Rahman", locale: "en" });
    expect(JSON.stringify(w.logged[w.logged.length - 1])).not.toContain("Karim");
  });
  it("refuses without a session and answers rate_limited", async () => {
    const w = world();
    w.setSession(null);
    expect(await updateProfileCore(w.deps, { name: "Karim", locale: "en" })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(
      await updateProfileCore(world({ limited: true }).deps, { name: "Karim", locale: "en" }),
    ).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });
});

describe("e-mail change (fresh sign-in and a new verification)", () => {
  it("start: needs a fresh sign-in before anything else", async () => {
    const w = world({ signedInAt: STALE });
    expect(await startEmailChangeCore(w.deps, { email: NEW_EMAIL })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(w.calls).toEqual(["authenticate"]);
    expect(w.account.calls).toEqual([]);
  });
  it("start: sends a code to the new address and changes no address yet", async () => {
    const w = world();
    expect(await startEmailChangeCore(w.deps, { email: NEW_EMAIL })).toEqual({
      ok: true,
      sentTo: "new_address",
    });
    expect(w.account.calls).toEqual(["startEmailChange"]);
    expect(w.calls).not.toContain("profile.setEmail");
    expect(w.calls.slice(-1)).toEqual(["audit:profile.email_change_started"]);
  });
  it("start: refuses an invalid or unchanged address", async () => {
    const w = world();
    expect(await startEmailChangeCore(w.deps, { email: "nope" })).toMatchObject({
      error: "validation",
      fields: { email: "invalid" },
    });
    expect(await startEmailChangeCore(w.deps, { email: OLD_EMAIL.toUpperCase() })).toMatchObject({
      error: "validation",
      fields: { email: "same" },
    });
    expect(w.account.calls).toEqual([]);
  });
  it("confirm: needs a fresh sign-in, then the right code, and only then stores the address", async () => {
    const stale = world({ signedInAt: STALE });
    expect(await confirmEmailChangeCore(stale.deps, { email: NEW_EMAIL, code: DEV_CODE })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });

    const w = world();
    await startEmailChangeCore(w.deps, { email: NEW_EMAIL });
    const wrong = await confirmEmailChangeCore(w.deps, { email: NEW_EMAIL, code: "000000" });
    expect(wrong).toMatchObject({ ok: false, error: "invalid_code" });
    expect(w.calls).not.toContain("profile.setEmail");

    expect(await confirmEmailChangeCore(w.deps, { email: NEW_EMAIL, code: DEV_CODE })).toEqual({
      ok: true,
    });
    expect(w.calls.slice(-2)).toEqual(["profile.setEmail", "audit:profile.email_changed"]);
    expect(w.logged).toContain(NEW_EMAIL);
  });
  it("confirm: a code for an address that was never started is expired, a malformed code is validation", async () => {
    const w = world();
    expect(
      await confirmEmailChangeCore(w.deps, { email: NEW_EMAIL, code: DEV_CODE }),
    ).toMatchObject({ ok: false, error: "expired_code" });
    expect(await confirmEmailChangeCore(w.deps, { email: NEW_EMAIL, code: "12" })).toMatchObject({
      ok: false,
      error: "validation",
      fields: { code: "malformed" },
    });
  });
  it("no audit entry holds an address or a code", async () => {
    const w = world();
    await startEmailChangeCore(w.deps, { email: NEW_EMAIL });
    await confirmEmailChangeCore(w.deps, { email: NEW_EMAIL, code: DEV_CODE });
    const audits = w.logged.filter((l) => typeof l === "object" && l !== null && "action" in l);
    expect(JSON.stringify(audits)).not.toMatch(/example\.test|123456/);
  });
  it("is unavailable when the identity port is not configured (R16)", async () => {
    const w = world({ noPorts: true });
    expect(await startEmailChangeCore(w.deps, { email: NEW_EMAIL })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("phone change (fresh sign-in and a new verification)", () => {
  const KEY = "k-0123456789abcdef";
  it("start: needs a fresh sign-in; the OTP service is not called without it", async () => {
    const w = world({ signedInAt: STALE });
    expect(
      await startPhoneChangeCore(w.deps, { phone: "01712345678", idempotencyKey: KEY }),
    ).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(w.otp.calls).toEqual([]);
  });
  it("start: normalises the number, sends the code and returns the masked number", async () => {
    const w = world();
    const r = await startPhoneChangeCore(w.deps, { phone: "01712345678", idempotencyKey: KEY });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.phoneMasked).not.toContain("1712345");
    expect(w.otp.calls).toEqual(["send"]);
    expect(w.calls.slice(-1)).toEqual(["audit:profile.phone_change_started"]);
  });
  it("start: refuses when the address of the request is not trusted (R16)", async () => {
    const w = world();
    const r = await startPhoneChangeCore(
      { ...w.deps, clientIp: () => null },
      { phone: "01712345678", idempotencyKey: KEY },
    );
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(w.otp.calls).toEqual([]);
  });
  it("start: refuses a number that is not a Bangladesh mobile and a bad key", async () => {
    const w = world();
    expect(
      await startPhoneChangeCore(w.deps, { phone: "12345", idempotencyKey: KEY }),
    ).toMatchObject({
      fields: { phone: "invalid" },
    });
    expect(
      await startPhoneChangeCore(w.deps, { phone: "01712345678", idempotencyKey: "a b" }),
    ).toMatchObject({
      fields: { idempotencyKey: "invalid" },
    });
    expect(w.otp.calls).toEqual([]);
  });
  it("confirm: needs a fresh sign-in, then maps a wrong code, a good code and no challenge", async () => {
    expect(
      await confirmPhoneChangeCore(world({ signedInAt: STALE }).deps, { code: DEV_CODE }),
    ).toEqual({ ok: false, error: "fresh_sign_in_required" });

    const w = world();
    expect(await confirmPhoneChangeCore(w.deps, { code: DEV_CODE })).toMatchObject({
      ok: false,
      error: "expired_code",
    });
    await startPhoneChangeCore(w.deps, { phone: "01712345678", idempotencyKey: KEY });
    expect(await confirmPhoneChangeCore(w.deps, { code: "000000" })).toMatchObject({
      ok: false,
      error: "invalid_code",
    });
    const ok = await confirmPhoneChangeCore(w.deps, { code: DEV_CODE });
    expect(ok).toMatchObject({ ok: true });
    expect(w.calls.slice(-1)).toEqual(["audit:profile.phone_changed"]);
    expect(await confirmPhoneChangeCore(w.deps, { code: "12ab" })).toMatchObject({
      error: "validation",
    });
  });
});

describe("changePasswordCore", () => {
  const good = {
    currentPassword: DEV_PASSWORD,
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
  };
  it("needs a fresh sign-in", async () => {
    const w = world({ signedInAt: STALE });
    expect(await changePasswordCore(w.deps, good)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(w.account.calls).toEqual([]);
  });
  it("authenticates, validates, rate limits, changes and audits, in that order", async () => {
    const w = world();
    expect(await changePasswordCore(w.deps, good)).toEqual({ ok: true });
    expect(w.calls).toEqual(["authenticate", "rateLimit", "audit:auth.password_changed"]);
    expect(w.account.calls).toEqual(["changePassword"]);
  });
  it("refuses a weak, a mismatched, an unchanged and an e-mail-like password before the provider", async () => {
    const w = world();
    const weak = await changePasswordCore(w.deps, {
      ...good,
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(weak).toMatchObject({ error: "validation", fields: { newPassword: "too_short" } });
    expect(
      await changePasswordCore(w.deps, { ...good, confirmPassword: "different-passphrase-x" }),
    ).toMatchObject({
      fields: { confirmPassword: "mismatch" },
    });
    expect(
      await changePasswordCore(w.deps, {
        currentPassword: NEW_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      }),
    ).toMatchObject({ fields: { newPassword: "same_as_current" } });
    expect(await changePasswordCore(w.deps, { ...good, currentPassword: "" })).toMatchObject({
      fields: { currentPassword: "required" },
    });
    expect(w.account.calls).toEqual([]);
  });
  it("maps a wrong current password to wrong_password and keeps no password anywhere", async () => {
    const w = world();
    const r = await changePasswordCore(w.deps, { ...good, currentPassword: "not-the-password" });
    expect(r).toEqual({
      ok: false,
      error: "wrong_password",
      fields: { currentPassword: "wrong" },
    });
    expect(JSON.stringify([r, w.logged, w.calls])).not.toMatch(
      /not-the-password|a-very-good-new-passphrase/,
    );
  });
  it("answers rate_limited before the provider and unavailable without the port", async () => {
    const limited = world({ limited: true });
    expect(await changePasswordCore(limited.deps, good)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.account.calls).toEqual([]);
    expect(await changePasswordCore(world({ noPorts: true }).deps, good)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
