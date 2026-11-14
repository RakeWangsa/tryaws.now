import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, CustomerProfile, ProfileRepo, RateLimitsRepo } from "@tc/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFakeState, resetFakeState } from "./fakes/outbox.ts";
import { FakeTotp, totpCodeAt } from "./fakes/totp.ts";
import {
  confirmTotpCore,
  disableTotpCore,
  otpauthUri,
  startTotpCore,
  type TotpDeps,
} from "./totp-actions.ts";

// WPU-X11: the customer's authenticator in /settings/security. R9 order in each core: authenticate (with
// the fresh sign-in of 6.1), validate, rate limit, execute (Cognito through the port with the customer's
// own access token), audit. The secret is shown once and is in no log, audit entry or error (U9, R14).

const NOW = new Date("2026-11-14T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SUB = "usubtotp0001";
const TOKEN = `dev.${SUB}`;
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 11 * 60_000);

const session = (signedInAt: Date): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "none",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

beforeEach(() => {
  resetFakeState();
  getFakeState().users.set("t@example.test", {
    sub: SUB,
    password: "pw-very-long-123",
    confirmed: true,
    name: "T",
    locale: "bn",
    refreshCount: 0,
  });
});
afterEach(() => vi.restoreAllMocks());

function world(
  over: {
    signedInAt?: Date;
    limited?: boolean;
    noPort?: boolean;
    token?: string | null;
    enabledAt?: Date | null;
    customerId?: string;
  } = {},
) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const totp = new FakeTotp({ now: () => NOW });
  let profile = {
    id: CUSTOMER,
    email: "t@example.test",
    totpEnabledAt: over.enabledAt ?? null,
  } as CustomerProfile;
  const profileRepo: Partial<ProfileRepo> = {
    get: async () => profile,
    setTotpEnabled: async (at) => {
      calls.push(`profile.setTotpEnabled:${at === null ? "null" : "time"}`);
      profile = { ...profile, totpEnabledAt: at };
      return { ok: true, replayed: false, value: profile };
    },
  };
  const audit: AuditRepo = {
    record: async (input) => {
      calls.push(`audit:${input.action}`);
      logged.push(input);
      return { ok: true, replayed: false, value: { id: "a" } };
    },
  };
  const rateLimits: RateLimitsRepo = {
    consume: async (limits) => {
      calls.push(`rateLimit:${limits.map((l) => l.action).join(",")}`);
      return over.limited === true
        ? { allowed: false, action: "x", retryAfterSeconds: 9 }
        : { allowed: true };
    },
  };
  const deps: TotpDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return session(over.signedInAt ?? FRESH);
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      // R8: the store is opened for the session's customer, never an id from the form.
      expect(customerId).toBe(CUSTOMER);
      return fn({ profile: profileRepo as ProfileRepo, audit, rateLimits });
    },
    totp: over.noPort === true ? null : totp,
    accessToken: () => (over.token === undefined ? TOKEN : over.token),
  };
  return { deps, calls, logged, totp, profile: () => profile };
}

const user = () => getFakeState().users.get("t@example.test")!;

describe("startTotpCore", () => {
  it("authenticates, rate limits, asks Cognito for a secret and audits, in that order; the secret is in no audit", async () => {
    const w = world();
    const r = await startTotpCore(w.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.otpauthUri).toBe(otpauthUri(r.secret));
    expect(w.calls).toEqual([
      "authenticate",
      "rateLimit:settings.totp",
      "audit:auth.totp_setup_started",
    ]);
    expect(w.totp.calls).toEqual(["associate"]);
    expect(JSON.stringify(w.logged)).not.toContain(r.secret);
  });

  it("needs a fresh sign-in (6.1) and refuses before any call", async () => {
    const w = world({ signedInAt: STALE });
    expect(await startTotpCore(w.deps)).toEqual({ ok: false, error: "fresh_sign_in_required" });
    expect(w.calls).toEqual(["authenticate"]);
    expect(w.totp.calls).toEqual([]);
  });

  it("refuses when the authenticator is already on, when rate limited, without a port or a token (R16)", async () => {
    expect(await startTotpCore(world({ enabledAt: NOW }).deps)).toEqual({
      ok: false,
      error: "validation",
      fields: { totp: "already_on" },
    });
    expect(await startTotpCore(world({ limited: true }).deps)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await startTotpCore(world({ noPort: true }).deps)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await startTotpCore(world({ token: null }).deps)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });
});

describe("confirmTotpCore", () => {
  it("verifies the code, switches TOTP on at Cognito, then stores the time and audits", async () => {
    const w = world();
    const started = await startTotpCore(w.deps);
    if (!started.ok) throw new Error("start failed");
    w.calls.length = 0;
    const code = totpCodeAt(started.secret, NOW);
    expect(await confirmTotpCore(w.deps, { code })).toEqual({ ok: true });
    expect(w.totp.calls).toEqual(["associate", "verify", "setPreference:true"]);
    expect(w.calls).toEqual([
      "authenticate",
      "rateLimit:settings.totp",
      "profile.setTotpEnabled:time",
      "audit:auth.totp_enabled",
    ]);
    expect(w.profile().totpEnabledAt).toEqual(NOW);
    expect(user().totpEnabled).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain(code);
  });

  it("a wrong code stores nothing and switches nothing on", async () => {
    const w = world();
    const started = await startTotpCore(w.deps);
    if (!started.ok) throw new Error("start failed");
    const wrong = totpCodeAt(started.secret, NOW) === "000000" ? "111111" : "000000";
    expect(await confirmTotpCore(w.deps, { code: wrong })).toEqual({
      ok: false,
      error: "invalid_code",
      fields: { code: "wrong" },
    });
    expect(w.profile().totpEnabledAt).toBeNull();
    expect(user().totpEnabled).toBeUndefined();
    expect(w.calls).not.toContain("profile.setTotpEnabled:time");
  });

  it("refuses a code that is not six digits before any call, and needs a fresh sign-in", async () => {
    const w = world();
    for (const bad of ["", "12345", "1234567", "abcdef", 123456, null]) {
      expect(await confirmTotpCore(w.deps, { code: bad })).toEqual({
        ok: false,
        error: "validation",
        fields: { code: "malformed" },
      });
    }
    expect(w.totp.calls).toEqual([]);
    expect(await confirmTotpCore(world({ signedInAt: STALE }).deps, { code: "123456" })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
  });

  it("is rate limited before Cognito is asked", async () => {
    const w = world({ limited: true });
    expect(await confirmTotpCore(w.deps, { code: "123456" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(w.totp.calls).toEqual([]);
  });

  it("when Cognito saved the preference but the database write fails, the answer is unavailable (R16)", async () => {
    const w = world();
    const started = await startTotpCore(w.deps);
    if (!started.ok) throw new Error("start failed");
    w.deps.store = async () => {
      throw new Error("db down");
    };
    expect(await confirmTotpCore(w.deps, { code: totpCodeAt(started.secret, NOW) })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("disableTotpCore", () => {
  it("switches TOTP off at Cognito, clears the stored time and audits; buying is blocked again", async () => {
    const w = world({ enabledAt: NOW });
    expect(await disableTotpCore(w.deps)).toEqual({ ok: true });
    expect(w.totp.calls).toEqual(["setPreference:false"]);
    expect(w.calls).toEqual([
      "authenticate",
      "rateLimit:settings.totp",
      "profile.setTotpEnabled:null",
      "audit:auth.totp_disabled",
    ]);
    expect(w.profile().totpEnabledAt).toBeNull();
  });

  it("needs a fresh sign-in and refuses when the authenticator is not on", async () => {
    expect(await disableTotpCore(world({ enabledAt: NOW, signedInAt: STALE }).deps)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(await disableTotpCore(world().deps)).toEqual({
      ok: false,
      error: "validation",
      fields: { totp: "not_on" },
    });
  });
});

describe("otpauthUri and the fake authenticator", () => {
  it("names the issuer, never the customer's e-mail", () => {
    expect(otpauthUri("JBSWY3DPEHPK3PXP")).toBe(
      "otpauth://totp/TryAWS.now?secret=JBSWY3DPEHPK3PXP&issuer=TryAWS.now&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("computes the RFC 6238 test vector (SHA1, T = 59 s gives 287082)", () => {
    // RFC 6238 Appendix B: the secret is the ASCII "12345678901234567890"; the 8-digit code is 94287082.
    expect(totpCodeAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", new Date(59_000))).toBe("287082");
  });
});
