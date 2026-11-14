import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cognitoIdentityProvider } from "../cognito-identity";
import { cognitoTotpPort } from "../cognito-totp";
import { PLANTED, POOL, SIGN_UP, challenge, cognitoError, json, tokens } from "./identity-fixtures";
import type { RecordedCall } from "./identity-fixtures";

// WPU-X11: the customer's authenticator (TOTP). Sign-in answers the SOFTWARE_TOKEN_MFA challenge inside
// the adapter (the Cognito Session never leaves it), and the enrolment calls AssociateSoftwareToken,
// VerifySoftwareToken and SetUserMFAPreference with the customer's own access token.

afterEach(() => vi.restoreAllMocks());

const EMAIL = "rahim@example.test";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

function sequence(answers: Array<() => Response>) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "");
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    const answer = answers[i] ?? answers[answers.length - 1]!;
    i += 1;
    return Promise.resolve(answer());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("signIn with an authenticator code", () => {
  it("answers SOFTWARE_TOKEN_MFA with the code and the session of the same flow, and returns the tokens", async () => {
    const { fetchImpl, calls } = sequence([() => challenge("SOFTWARE_TOKEN_MFA"), () => tokens()]);
    const provider = cognitoIdentityProvider(POOL, SIGN_UP, fetchImpl);
    const result = await provider.signIn({
      email: EMAIL,
      password: "pw-123456789",
      totpCode: "123456",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "tokens",
        accessToken: PLANTED.accessToken,
        refreshToken: PLANTED.refreshToken,
        expiresInSeconds: 3600,
      },
    });
    expect(calls.map((c) => c.headers["X-Amz-Target"])).toEqual([
      "AWSCognitoIdentityProviderService.InitiateAuth",
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    ]);
    expect(calls[1]!.body).toEqual({
      ClientId: POOL.clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: PLANTED.session,
      ChallengeResponses: { USERNAME: EMAIL, SOFTWARE_TOKEN_MFA_CODE: "123456" },
    });
  });

  it("without a code the challenge is reported and no second call is made", async () => {
    const { fetchImpl, calls } = sequence([() => challenge("SOFTWARE_TOKEN_MFA")]);
    const result = await cognitoIdentityProvider(POOL, SIGN_UP, fetchImpl).signIn({
      email: EMAIL,
      password: "pw-123456789",
    });
    expect(result).toEqual({ ok: true, value: { kind: "challenge", challenge: "totp" } });
    expect(calls).toHaveLength(1);
  });

  it.each(["CodeMismatchException", "NotAuthorizedException", "ExpiredCodeException"])(
    "a wrong, reused or expired code (%s) is denied, like a wrong password",
    async (type) => {
      const { fetchImpl } = sequence([
        () => challenge("SOFTWARE_TOKEN_MFA"),
        () => cognitoError(type),
      ]);
      const result = await cognitoIdentityProvider(POOL, SIGN_UP, fetchImpl).signIn({
        email: EMAIL,
        password: "pw-123456789",
        totpCode: "000000",
      });
      expect(result).toEqual({ ok: false, kind: "denied" });
    },
  );

  it("a limit is rate_limited; another challenge after the code, or no tokens, is unavailable (R16)", async () => {
    const run = async (second: () => Response) => {
      const { fetchImpl } = sequence([() => challenge("SOFTWARE_TOKEN_MFA"), second]);
      return cognitoIdentityProvider(POOL, SIGN_UP, fetchImpl).signIn({
        email: EMAIL,
        password: "pw-123456789",
        totpCode: "123456",
      });
    };
    expect(await run(() => cognitoError("TooManyRequestsException"))).toEqual({
      ok: false,
      kind: "rate_limited",
    });
    expect(await run(() => challenge("SOFTWARE_TOKEN_MFA"))).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(await run(() => json(200, {}))).toEqual({ ok: false, kind: "unavailable" });
    expect(await run(() => json(500, {}))).toEqual({ ok: false, kind: "unavailable" });
  });

  it("a code is never sent for another challenge", async () => {
    const { fetchImpl, calls } = sequence([() => challenge("NEW_PASSWORD_REQUIRED")]);
    const result = await cognitoIdentityProvider(POOL, SIGN_UP, fetchImpl).signIn({
      email: EMAIL,
      password: "pw-123456789",
      totpCode: "123456",
    });
    expect(result).toEqual({ ok: true, value: { kind: "challenge", challenge: "other" } });
    expect(calls).toHaveLength(1);
  });
});

describe("cognitoTotpPort", () => {
  it("associate posts the access token and returns the secret, nothing else", async () => {
    const { fetchImpl, calls } = sequence([
      () => json(200, { SecretCode: SECRET, Session: PLANTED.session }),
    ]);
    const result = await cognitoTotpPort(POOL, fetchImpl).associate(PLANTED.accessToken);
    expect(result).toEqual({ ok: true, value: { secret: SECRET } });
    expect(calls[0]!.headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.AssociateSoftwareToken",
    );
    expect(calls[0]!.body).toEqual({ AccessToken: PLANTED.accessToken });
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("associate refuses a secret that is not base32 text of a sane length (R16)", async () => {
    for (const bad of ["", "short", "lower-case-not-base32-0189", 42, "A".repeat(200)]) {
      const { fetchImpl } = sequence([() => json(200, { SecretCode: bad })]);
      expect(await cognitoTotpPort(POOL, fetchImpl).associate("t")).toEqual({
        ok: false,
        kind: "unavailable",
      });
    }
  });

  it("verify then enable: VerifySoftwareToken SUCCESS, then SetUserMFAPreference enabled and preferred", async () => {
    const { fetchImpl, calls } = sequence([
      () => json(200, { Status: "SUCCESS" }),
      () => json(200, {}),
    ]);
    const port = cognitoTotpPort(POOL, fetchImpl);
    expect(await port.verify(PLANTED.accessToken, "123456")).toEqual({ ok: true, value: true });
    expect(await port.setPreference(PLANTED.accessToken, true)).toEqual({ ok: true, value: true });
    expect(calls[0]!.body).toEqual({
      AccessToken: PLANTED.accessToken,
      UserCode: "123456",
      FriendlyDeviceName: "TryAWS.now",
    });
    expect(calls[1]!.headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.SetUserMFAPreference",
    );
    expect(calls[1]!.body).toEqual({
      AccessToken: PLANTED.accessToken,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });
  });

  it("disable sends Enabled false", async () => {
    const { fetchImpl, calls } = sequence([() => json(200, {})]);
    await cognitoTotpPort(POOL, fetchImpl).setPreference("t", false);
    expect(calls[0]!.body).toEqual({
      AccessToken: "t",
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    });
  });

  it("verify: a status other than SUCCESS or a wrong code is invalid_code; a bad token is denied", async () => {
    const run = async (answer: () => Response) => {
      const { fetchImpl } = sequence([answer]);
      return cognitoTotpPort(POOL, fetchImpl).verify("t", "123456");
    };
    expect(await run(() => json(200, { Status: "ERROR" }))).toEqual({
      ok: false,
      kind: "invalid_code",
    });
    expect(await run(() => cognitoError("EnableSoftwareTokenMFAException"))).toEqual({
      ok: false,
      kind: "invalid_code",
    });
    expect(await run(() => cognitoError("CodeMismatchException"))).toEqual({
      ok: false,
      kind: "invalid_code",
    });
    expect(await run(() => cognitoError("NotAuthorizedException"))).toEqual({
      ok: false,
      kind: "denied",
    });
    expect(await run(() => cognitoError("LimitExceededException"))).toEqual({
      ok: false,
      kind: "rate_limited",
    });
    expect(await run(() => json(503, {}))).toEqual({ ok: false, kind: "unavailable" });
  });

  it("refuses a code that is not six digits before any call", async () => {
    const { fetchImpl, calls } = sequence([() => json(200, { Status: "SUCCESS" })]);
    const port = cognitoTotpPort(POOL, fetchImpl);
    for (const bad of ["", "12345", "1234567", "12345a"]) {
      expect(await port.verify("t", bad)).toEqual({ ok: false, kind: "invalid_code" });
    }
    expect(calls).toHaveLength(0);
  });

  it("no secret, code, token or session is in a returned failure, an inspection or a log (R14)", async () => {
    const sinks = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const collected: unknown[] = [];
    for (const answer of [
      () => cognitoError("NotAuthorizedException"),
      () => json(500, { message: SECRET }),
      () => json(200, `${SECRET} ${PLANTED.session}`),
    ]) {
      const { fetchImpl } = sequence([answer]);
      const port = cognitoTotpPort(POOL, fetchImpl);
      collected.push(inspect(port, { depth: 6 }));
      collected.push(await port.associate(PLANTED.accessToken));
      collected.push(await port.verify(PLANTED.accessToken, PLANTED.code));
      collected.push(await port.setPreference(PLANTED.accessToken, true));
    }
    const all = JSON.stringify(collected);
    for (const s of [SECRET, PLANTED.session, PLANTED.accessToken, PLANTED.code]) {
      expect(all).not.toContain(s);
    }
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  });
});
