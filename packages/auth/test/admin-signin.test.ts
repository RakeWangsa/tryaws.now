import type { AdminIdentity } from "@tc/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminSessionDeps } from "../admin";
import {
  cognitoAdminSignInPort,
  signInAdmin,
  type AdminSignInInput,
  type AdminSignInPort,
} from "../admin-signin";
import { createTestIssuer, type TestIssuer } from "../testing/keys";
import { createAccessTokenVerifier } from "../tokens";

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock = { now: () => NOW };
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
let issuer: TestIssuer;

beforeAll(() => {
  issuer = createTestIssuer(clock);
});

const input = (over: Partial<AdminSignInInput> = {}): AdminSignInInput => ({
  email: "ops@ticoncloud.example",
  password: "correct horse battery staple",
  code: "123456",
  viewerAddress: "203.0.113.5:44321",
  ...over,
});

function deps(found: AdminIdentity | null = { id: ADMIN_ID, role: "ops", status: "active" }) {
  const d: AdminSessionDeps = {
    verifier: createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache }),
    lookup: () => Promise.resolve(found),
    allowlist: ["203.0.113.0/24"],
    clock,
  };
  return d;
}

// The access token has the shape Cognito gives it: no `amr` claim (WPU-Z15).
function port(over: Partial<AdminSignInPort> = {}): AdminSignInPort {
  return {
    start: vi.fn(() => Promise.resolve({ kind: "mfa_challenge", session: "sess-1" } as const)),
    confirm: vi.fn(() =>
      Promise.resolve({
        kind: "signed_in",
        accessToken: issuer.sign({ sub: "admin-sub-1" }),
        expiresInSeconds: 28_800,
      } as const),
    ),
    ...over,
  };
}

describe("signInAdmin", () => {
  it("password, then the TOTP code, then a checked session: the cookie value and its expiry", async () => {
    const p = port();
    const out = await signInAdmin(p, deps(), input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.accessToken.split(".")).toHaveLength(3);
    expect(out.expiresAt.getTime()).toBe(NOW.getTime() + 28_800_000);
    expect(p.start).toHaveBeenCalledWith("ops@ticoncloud.example", "correct horse battery staple");
    expect(p.confirm).toHaveBeenCalledWith("ops@ticoncloud.example", "sess-1", "123456");
  });

  it("no MFA means no sign-in: Cognito answering without the TOTP challenge is refused", async () => {
    // A direct result and MFA_SETUP both come out of the port as "other_challenge" (tested below).
    const p = port({ start: vi.fn(() => Promise.resolve({ kind: "other_challenge" } as const)) });
    expect(await signInAdmin(p, deps(), input())).toEqual({ ok: false, reason: "denied" });
    expect(p.confirm).not.toHaveBeenCalled();
  });

  it("a wrong password, a wrong code and an unknown user all give the same answer", async () => {
    const denied = { ok: false, reason: "denied" };
    expect(
      await signInAdmin(
        port({ start: () => Promise.resolve({ kind: "denied" }) }),
        deps(),
        input(),
      ),
    ).toEqual(denied);
    expect(
      await signInAdmin(
        port({ confirm: () => Promise.resolve({ kind: "denied" }) }),
        deps(),
        input(),
      ),
    ).toEqual(denied);
  });

  it("a valid session of an unknown or disabled admin gets no cookie", async () => {
    expect(await signInAdmin(port(), deps(null), input())).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(
      await signInAdmin(port(), deps({ id: ADMIN_ID, role: "ops", status: "disabled" }), input()),
    ).toEqual({ ok: false, reason: "denied" });
  });

  it("outside the allowlist Cognito is not even asked", async () => {
    const p = port();
    expect(await signInAdmin(p, deps(), input({ viewerAddress: "198.51.100.1:80" }))).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(p.start).not.toHaveBeenCalled();
  });

  it("a malformed input is refused before Cognito is asked", async () => {
    const p = port();
    for (const bad of [
      input({ email: "" }),
      input({ email: "no-at-sign" }),
      input({ password: "" }),
      input({ password: "x".repeat(300) }),
      input({ code: "12345" }),
      input({ code: "12345a" }),
      input({ code: "1234567" }),
    ]) {
      expect(await signInAdmin(p, deps(), bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(p.start).not.toHaveBeenCalled();
  });

  it("an unavailable port is reported as unavailable, never as a session", async () => {
    expect(
      await signInAdmin(
        port({ start: () => Promise.resolve({ kind: "unavailable" }) }),
        deps(),
        input(),
      ),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await signInAdmin(
        port({ confirm: () => Promise.reject(new Error("boom password=hunter2")) }),
        deps(),
        input(),
      ),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

// WPU-Z15, ruling of 2026-11-13: the proof of TOTP is the sign-in flow itself. The admin pool requires
// TOTP, and the session comes only out of the SOFTWARE_TOKEN_MFA challenge answered in the same flow;
// any other path is refused (R16). These run signInAdmin over the real Cognito port and a fake fetch.
describe("signInAdmin over the Cognito port: a session only after the answered TOTP challenge", () => {
  type Answer = { readonly status: number; readonly body: unknown };
  function cognito(answers: Answer[]) {
    const calls: { target: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        target: headers["X-Amz-Target"] ?? "",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer left");
      return new Response(JSON.stringify(next.body), { status: next.status });
    });
    return {
      calls,
      port: cognitoAdminSignInPort(issuer.pool, fetchImpl as unknown as typeof fetch),
    };
  }
  const tokens = (accessToken: string) => ({
    AuthenticationResult: { AccessToken: accessToken, ExpiresIn: 3600, TokenType: "Bearer" },
  });
  const challenge = (name: string) => ({ ChallengeName: name, Session: "cognito-session-1" });

  it("password, SOFTWARE_TOKEN_MFA, the code in the same session: the session comes out", async () => {
    const accessToken = issuer.sign({ sub: "admin-sub-1" });
    const { calls, port: p } = cognito([
      { status: 200, body: challenge("SOFTWARE_TOKEN_MFA") },
      { status: 200, body: tokens(accessToken) },
    ]);
    const out = await signInAdmin(p, deps(), input());
    expect(out).toEqual({
      ok: true,
      adminId: ADMIN_ID,
      accessToken,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect(calls.map((c) => c.target)).toEqual([
      "AWSCognitoIdentityProviderService.InitiateAuth",
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    ]);
    expect(calls[1]?.body).toMatchObject({
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: "cognito-session-1",
      ChallengeResponses: { USERNAME: "ops@ticoncloud.example", SOFTWARE_TOKEN_MFA_CODE: "123456" },
    });
  });

  it("no challenge: tokens straight from the password are refused, and the code is never sent", async () => {
    const { calls, port: p } = cognito([
      { status: 200, body: tokens(issuer.sign({ sub: "admin-sub-1" })) },
    ]);
    expect(await signInAdmin(p, deps(), input())).toEqual({ ok: false, reason: "denied" });
    expect(calls).toHaveLength(1);
  });

  it("another challenge is refused, and the code is never sent", async () => {
    for (const name of [
      "MFA_SETUP",
      "NEW_PASSWORD_REQUIRED",
      "SMS_MFA",
      "EMAIL_OTP",
      "SELECT_MFA_TYPE",
      "CUSTOM_CHALLENGE",
    ]) {
      const { calls, port: p } = cognito([{ status: 200, body: challenge(name) }]);
      expect(await signInAdmin(p, deps(), input()), name).toEqual({ ok: false, reason: "denied" });
      expect(calls, name).toHaveLength(1);
    }
  });

  it("an answer to the code that is another challenge, with or without tokens, is refused", async () => {
    const token = issuer.sign({ sub: "admin-sub-1" });
    for (const second of [
      challenge("MFA_SETUP"),
      challenge("SOFTWARE_TOKEN_MFA"),
      { ...challenge("SOFTWARE_TOKEN_MFA"), ...tokens(token) },
    ]) {
      const { port: p } = cognito([
        { status: 200, body: challenge("SOFTWARE_TOKEN_MFA") },
        { status: 200, body: second },
      ]);
      expect(await signInAdmin(p, deps(), input()), JSON.stringify(second)).toEqual({
        ok: false,
        reason: "denied",
      });
    }
  });
});

describe("cognitoAdminSignInPort (plain fetch, no SDK)", () => {
  const pool = {
    region: "ap-southeast-1",
    userPoolId: "ap-southeast-1_AdMin123",
    clientId: "adminclient1234567890",
  };
  const reply = (status: number, body: unknown) =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  const target = (f: ReturnType<typeof reply>) =>
    (f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }])[1];

  it("start: USER_PASSWORD_AUTH, and a SOFTWARE_TOKEN_MFA challenge keeps its session", async () => {
    const f = reply(200, { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "abc" });
    const out = await cognitoAdminSignInPort(pool, f as unknown as typeof fetch).start(
      "a@b.c",
      "pw",
    );
    expect(out).toEqual({ kind: "mfa_challenge", session: "abc" });
    expect(target(f).headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.InitiateAuth",
    );
    expect(JSON.parse(target(f).body)).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: pool.clientId,
      AuthParameters: { USERNAME: "a@b.c", PASSWORD: "pw" },
    });
  });

  it("start: a direct result or another challenge is not an MFA challenge", async () => {
    const direct = reply(200, { AuthenticationResult: { AccessToken: "a.b.c", ExpiresIn: 3600 } });
    expect(
      await cognitoAdminSignInPort(pool, direct as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "other_challenge",
    });
    const setup = reply(200, { ChallengeName: "MFA_SETUP", Session: "s" });
    expect(
      await cognitoAdminSignInPort(pool, setup as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "other_challenge",
    });
  });

  it("start: NotAuthorizedException is denied; a 5xx, bad JSON and a throw are unavailable", async () => {
    const na = reply(400, { __type: "NotAuthorizedException" });
    expect(
      await cognitoAdminSignInPort(pool, na as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "denied",
    });
    const five = reply(500, {});
    expect(
      await cognitoAdminSignInPort(pool, five as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "unavailable",
    });
    const bad = vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 })));
    expect(
      await cognitoAdminSignInPort(pool, bad as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "unavailable",
    });
    const boom = vi.fn(() => Promise.reject(new Error("secret in message")));
    expect(
      await cognitoAdminSignInPort(pool, boom as unknown as typeof fetch).start("a", "b"),
    ).toEqual({
      kind: "unavailable",
    });
  });

  it("confirm: RespondToAuthChallenge with the TOTP code returns the access token", async () => {
    const f = reply(200, { AuthenticationResult: { AccessToken: "a.b.c", ExpiresIn: 28800 } });
    const out = await cognitoAdminSignInPort(pool, f as unknown as typeof fetch).confirm(
      "a@b.c",
      "abc",
      "123456",
    );
    expect(out).toEqual({ kind: "signed_in", accessToken: "a.b.c", expiresInSeconds: 28_800 });
    expect(target(f).headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    );
    expect(JSON.parse(target(f).body)).toEqual({
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      ClientId: pool.clientId,
      Session: "abc",
      ChallengeResponses: { USERNAME: "a@b.c", SOFTWARE_TOKEN_MFA_CODE: "123456" },
    });
  });

  it("confirm: a wrong code (CodeMismatchException) is denied", async () => {
    const f = reply(400, { __type: "CodeMismatchException" });
    expect(
      await cognitoAdminSignInPort(pool, f as unknown as typeof fetch).confirm("a", "s", "000000"),
    ).toEqual({
      kind: "denied",
    });
  });
});
