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

function port(over: Partial<AdminSignInPort> = {}, amr: unknown = ["pwd", "mfa"]): AdminSignInPort {
  return {
    start: vi.fn(() => Promise.resolve({ kind: "mfa_challenge", session: "sess-1" } as const)),
    confirm: vi.fn(() =>
      Promise.resolve({
        kind: "signed_in",
        accessToken: issuer.sign({ sub: "admin-sub-1", amr }),
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

  it("a token without the mfa method, even after the challenge, is refused", async () => {
    expect(await signInAdmin(port({}, ["pwd"]), deps(), input())).toEqual({
      ok: false,
      reason: "denied",
    });
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
