import type { AdminSignInOutcome } from "@tc/auth";
import { describe, expect, it, vi } from "vitest";
import { makeSignIn, makeSignOut, type SignInDeps, type SignInRequest } from "./sign-in.ts";

const NOW = new Date("2026-11-11T10:00:00.000Z");
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const request = (over: Partial<SignInRequest> = {}): SignInRequest => ({
  email: "ops@ticoncloud.example",
  password: "correct horse battery staple",
  code: "123456",
  viewerAddress: "203.0.113.5:44321",
  userAgent: "agent",
  ...over,
});

function deps(over: Partial<SignInDeps> = {}) {
  const calls: string[] = [];
  const signIn = vi.fn<SignInDeps["signIn"]>(async () => {
    calls.push("signIn");
    return {
      ok: true,
      adminId: ADMIN_ID,
      accessToken: "aaa.bbb.ccc",
      expiresAt: new Date(NOW.getTime() + 28_800_000),
    } satisfies AdminSignInOutcome;
  });
  const limiter = vi.fn<SignInDeps["limiter"]>(async () => {
    calls.push("limiter");
    return true;
  });
  const audit = vi.fn<SignInDeps["audit"]>(async () => {
    calls.push("audit");
  });
  const d: SignInDeps = {
    allowed: () => true,
    signIn,
    limiter,
    audit,
    clock: { now: () => NOW },
    ...over,
  };
  return { d, calls, signIn, limiter, audit };
}

describe("makeSignIn (R9 order: authorize, validate, rate limit, execute, audit)", () => {
  it("runs the steps in that order and returns the token with its lifetime", async () => {
    const { d, calls } = deps();
    expect(await makeSignIn(d)(request())).toEqual({
      ok: true,
      accessToken: "aaa.bbb.ccc",
      maxAgeSeconds: 28_800,
    });
    expect(calls).toEqual(["limiter", "signIn", "audit"]);
  });

  it("audits the success with the admin id, the address without the port, and the agent", async () => {
    const { d, audit } = deps();
    await makeSignIn(d)(request());
    expect(audit).toHaveBeenCalledWith({
      adminId: ADMIN_ID,
      ip: "203.0.113.5",
      userAgent: "agent",
      outcome: "ok",
    });
  });

  it("outside the allowlist: refused at once, no limiter, no Cognito, no database write", async () => {
    const { d, calls } = deps({ allowed: () => false });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "denied" });
    expect(calls).toEqual([]);
  });

  it("a malformed form is `invalid`, audited, and costs no Cognito call", async () => {
    const { d, calls, audit } = deps();
    expect(await makeSignIn(d)(request({ code: "12" }))).toEqual({ ok: false, code: "invalid" });
    expect(calls).toEqual(["audit"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: null, outcome: "invalid" }),
    );
  });

  it("over the rate limit: refused before Cognito, audited as rate_limited", async () => {
    const { d, calls, audit } = deps({ limiter: async () => false });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "rate_limited" });
    expect(calls).toEqual(["audit"]); // the limiter was replaced; Cognito was not asked
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rate_limited" }));
  });

  it("a refusal of Cognito (no MFA, wrong code, disabled admin) is `denied` with no cookie", async () => {
    const { d, audit } = deps({ signIn: async () => ({ ok: false, reason: "denied" }) });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "denied" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: null, outcome: "denied", ip: "203.0.113.5" }),
    );
  });

  it("an unavailable service is reported as such", async () => {
    const { d } = deps({ signIn: async () => ({ ok: false, reason: "unavailable" }) });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "unavailable" });
  });

  it("R16: when the audit row of a success cannot be written there is no session", async () => {
    const { d } = deps({
      audit: async () => {
        throw new Error("db down password=hunter2");
      },
    });
    const out = await makeSignIn(d)(request());
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("when the limiter fails there is no sign-in", async () => {
    const { d, signIn } = deps({
      limiter: async () => {
        throw new Error("db");
      },
    });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "unavailable" });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("an expired-on-arrival token (lifetime 0) gets no cookie", async () => {
    const { d } = deps({
      signIn: async () => ({ ok: true, adminId: ADMIN_ID, accessToken: "a.b.c", expiresAt: NOW }),
    });
    expect(await makeSignIn(d)(request())).toEqual({ ok: false, code: "denied" });
  });

  it("passes the password and the code to the sign-in and to nothing else", async () => {
    const { d, signIn, audit, limiter } = deps();
    await makeSignIn(d)(request());
    expect(signIn).toHaveBeenCalledWith({
      email: "ops@ticoncloud.example",
      password: "correct horse battery staple",
      code: "123456",
      viewerAddress: "203.0.113.5:44321",
    });
    expect(JSON.stringify([audit.mock.calls, limiter.mock.calls])).not.toMatch(
      /correct horse|123456|ticoncloud\.example/,
    );
  });
});

describe("makeSignOut", () => {
  it("audits the sign-out of the admin that was signed in", async () => {
    const audit = vi.fn(async () => {});
    await makeSignOut({ audit })({ adminId: ADMIN_ID, ip: "203.0.113.5", userAgent: "agent" });
    expect(audit).toHaveBeenCalledWith({
      adminId: ADMIN_ID,
      ip: "203.0.113.5",
      userAgent: "agent",
      outcome: "ok",
    });
  });

  it("a failing audit does not keep the admin signed in", async () => {
    const audit = vi.fn(async () => {
      throw new Error("db");
    });
    await expect(
      makeSignOut({ audit })({ adminId: ADMIN_ID, ip: "203.0.113.5" }),
    ).resolves.toBeUndefined();
  });
});
