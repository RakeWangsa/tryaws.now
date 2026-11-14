import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cognitoIdentityProvider, secretHash } from "../cognito-identity";
import type { IdentityProvider, IdpResult } from "../identity";
import {
  CLIENTS,
  CUSTOMER,
  PLANTED,
  POOL,
  SIGN_UP,
  challenge,
  cognitoError,
  emptyOk,
  json,
  recording,
  signUpOk,
  tokens,
} from "./identity-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const EMAIL = "rahim@example.test";
const NEW_PASSWORD = "Xk9#mQ2$vL7p";

type Call = (p: IdentityProvider) => Promise<IdpResult<unknown>>;
const OPS: Record<string, { target: string; call: Call }> = {
  signUp: {
    target: "SignUp",
    call: (p) => p.signUp({ email: EMAIL, password: NEW_PASSWORD, name: "Rahim", locale: "bn" }),
  },
  confirmSignUp: {
    target: "ConfirmSignUp",
    call: (p) => p.confirmSignUp({ email: EMAIL, code: "123456" }),
  },
  resendConfirmationCode: {
    target: "ResendConfirmationCode",
    call: (p) => p.resendConfirmationCode(EMAIL),
  },
  signIn: {
    target: "InitiateAuth",
    call: (p) => p.signIn({ email: EMAIL, password: NEW_PASSWORD }),
  },
  forgotPassword: { target: "ForgotPassword", call: (p) => p.forgotPassword(EMAIL) },
  confirmForgotPassword: {
    target: "ConfirmForgotPassword",
    call: (p) =>
      p.confirmForgotPassword({ email: EMAIL, code: "123456", newPassword: NEW_PASSWORD }),
  },
  revokeRefreshToken: {
    target: "RevokeToken",
    call: (p) => p.revokeRefreshToken("a.refresh.token"),
  },
};

const happy: Record<string, () => Response> = {
  signUp: () => signUpOk(),
  confirmSignUp: emptyOk,
  resendConfirmationCode: () => json(200, { CodeDeliveryDetails: {} }),
  signIn: () => tokens(),
  forgotPassword: () => json(200, { CodeDeliveryDetails: {} }),
  confirmForgotPassword: emptyOk,
  revokeRefreshToken: emptyOk,
};

async function run(op: string, answer: () => Response | Promise<Response>) {
  const { fetchImpl, calls } = recording(answer);
  const provider = cognitoIdentityProvider(POOL, CLIENTS, fetchImpl);
  const result = await OPS[op]!.call(provider);
  return { result, calls };
}

// WPU-X12: the three operations that may write attributes or confirm an address go through the
// server-only sign-up client with a SecretHash; everything else stays on the token-issuing client.
// Round 3 (security review finding 3): the password reset too, so the public client cannot have a reset
// code sent (the custom-message trigger refuses a customer reset from any other client).
const SIGN_UP_OPS = [
  "signUp",
  "confirmSignUp",
  "resendConfirmationCode",
  "forgotPassword",
  "confirmForgotPassword",
];
const clientOf = (op: string) => (SIGN_UP_OPS.includes(op) ? SIGN_UP.clientId : CUSTOMER.clientId);
const CUSTOMER_HASH = createHmac("sha256", CUSTOMER.clientSecret)
  .update(EMAIL + CUSTOMER.clientId)
  .digest("base64");
// AWS developer guide, "Computing secret hash values": Base64(HMAC_SHA256(secret, username + clientId)).
const EXPECTED_HASH = createHmac("sha256", SIGN_UP.clientSecret)
  .update(EMAIL + SIGN_UP.clientId)
  .digest("base64");

describe("the secret hash", () => {
  it("is the documented vector (openssl dgst -sha256 -hmac, base64)", () => {
    // echo -n "rahim@example.test1example23456789" | openssl dgst -sha256 -hmac <secret> -binary | base64
    expect(secretHash(SIGN_UP.clientSecret, EMAIL, SIGN_UP.clientId)).toBe(
      "YAsnVvfQ7gbfYNyqIQkyG8mH80ncD9d70Z+i7WjGbrE=",
    );
    expect(EXPECTED_HASH).toBe("YAsnVvfQ7gbfYNyqIQkyG8mH80ncD9d70Z+i7WjGbrE=");
  });

  it("changes with the username, the client id and the secret", () => {
    const base = secretHash(SIGN_UP.clientSecret, EMAIL, SIGN_UP.clientId);
    expect(secretHash(SIGN_UP.clientSecret, "other@example.test", SIGN_UP.clientId)).not.toBe(base);
    expect(secretHash(SIGN_UP.clientSecret, EMAIL, POOL.clientId)).not.toBe(base);
    expect(secretHash(`${SIGN_UP.clientSecret}x`, EMAIL, SIGN_UP.clientId)).not.toBe(base);
  });
});

describe("the two clients", () => {
  it.each(SIGN_UP_OPS)("%s goes through the sign-up client with its SecretHash", async (op) => {
    const { calls } = await run(op, happy[op]!);
    expect(calls[0]!.body["ClientId"]).toBe(SIGN_UP.clientId);
    expect(calls[0]!.body["SecretHash"]).toBe(EXPECTED_HASH);
  });

  // Round 4: the token-issuing client has a secret too, so Cognito itself refuses SignUp, Resend and
  // ForgotPassword through it for anyone who does not hold the secret.
  it.each(Object.keys(OPS).filter((op) => !SIGN_UP_OPS.includes(op)))(
    "%s stays on the token-issuing client, never with the sign-up client's id or secret",
    async (op) => {
      const { calls } = await run(op, happy[op]!);
      expect(calls[0]!.body["ClientId"]).toBe(CUSTOMER.clientId);
      expect(calls[0]!.rawBody).not.toContain(SIGN_UP.clientId);
      expect(calls[0]!.rawBody).not.toContain(SIGN_UP.clientSecret);
    },
  );

  it("sign-in carries SECRET_HASH of the e-mail and the customer client id in AuthParameters", async () => {
    const { calls } = await run("signIn", happy["signIn"]!);
    expect(calls[0]!.body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CUSTOMER.clientId,
      AuthParameters: { USERNAME: EMAIL, PASSWORD: NEW_PASSWORD, SECRET_HASH: CUSTOMER_HASH },
    });
  });

  it("revoking a refresh token carries the customer client secret (RevokeToken takes no hash)", async () => {
    const { calls } = await run("revokeRefreshToken", happy["revokeRefreshToken"]!);
    expect(calls[0]!.body).toEqual({
      ClientId: CUSTOMER.clientId,
      ClientSecret: CUSTOMER.clientSecret,
      Token: "a.refresh.token",
    });
  });

  it.each(Object.keys(OPS))("%s never sends a client secret in a header", async (op) => {
    const { calls } = await run(op, happy[op]!);
    expect(calls[0]!.rawBody).not.toContain(SIGN_UP.clientSecret);
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(SIGN_UP.clientSecret);
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(CUSTOMER.clientSecret);
    // the customer secret itself goes out only as the ClientSecret of RevokeToken
    expect(calls[0]!.rawBody.includes(CUSTOMER.clientSecret), op).toBe(op === "revokeRefreshToken");
  });

  it("only the sign-up client is ever sent user attributes", async () => {
    for (const op of Object.keys(OPS)) {
      const { calls } = await run(op, happy[op]!);
      if (calls[0]!.rawBody.includes("UserAttributes")) {
        expect(calls[0]!.body["ClientId"]).toBe(SIGN_UP.clientId);
      }
    }
  });
});

describe("the wire", () => {
  it.each(Object.keys(OPS))(
    "%s posts the right target, the client id and no signature",
    async (op) => {
      const { calls } = await run(op, happy[op]!);
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c.url).toBe("https://cognito-idp.eu-west-1.amazonaws.com/");
      expect(c.method).toBe("POST");
      expect(c.headers).toEqual({
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${OPS[op]!.target}`,
      });
      expect(c.body["ClientId"]).toBe(clientOf(op));
      expect(c.hasSignal).toBe(true);
      for (const k of Object.keys(c.headers)) {
        expect(k.toLowerCase()).not.toMatch(
          /authorization|x-amz-date|x-amz-security-token|x-amz-content/,
        );
      }
    },
  );

  it("SignUp sends exactly email, name and locale, and the password in the body", async () => {
    const { calls } = await run("signUp", happy["signUp"]!);
    expect(calls[0]!.body).toEqual({
      ClientId: SIGN_UP.clientId,
      SecretHash: EXPECTED_HASH,
      Username: EMAIL,
      Password: NEW_PASSWORD,
      UserAttributes: [
        { Name: "email", Value: EMAIL },
        { Name: "name", Value: "Rahim" },
        { Name: "locale", Value: "bn" },
      ],
    });
    expect(calls[0]!.rawBody).not.toContain("phone_number");
  });

  it("the other bodies are exactly the documented ones", async () => {
    expect((await run("confirmSignUp", emptyOk)).calls[0]!.body).toEqual({
      ClientId: SIGN_UP.clientId,
      SecretHash: EXPECTED_HASH,
      Username: EMAIL,
      ConfirmationCode: "123456",
    });
    expect((await run("resendConfirmationCode", emptyOk)).calls[0]!.body).toEqual({
      ClientId: SIGN_UP.clientId,
      SecretHash: EXPECTED_HASH,
      Username: EMAIL,
    });
    expect((await run("signIn", happy["signIn"]!)).calls[0]!.body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CUSTOMER.clientId,
      AuthParameters: { USERNAME: EMAIL, PASSWORD: NEW_PASSWORD, SECRET_HASH: CUSTOMER_HASH },
    });
    expect((await run("forgotPassword", emptyOk)).calls[0]!.body).toEqual({
      ClientId: SIGN_UP.clientId,
      SecretHash: EXPECTED_HASH,
      Username: EMAIL,
    });
    expect((await run("confirmForgotPassword", emptyOk)).calls[0]!.body).toEqual({
      ClientId: SIGN_UP.clientId,
      SecretHash: EXPECTED_HASH,
      Username: EMAIL,
      ConfirmationCode: "123456",
      Password: NEW_PASSWORD,
    });
    expect((await run("revokeRefreshToken", emptyOk)).calls[0]!.body).toEqual({
      ClientId: CUSTOMER.clientId,
      ClientSecret: CUSTOMER.clientSecret,
      Token: "a.refresh.token",
    });
  });

  it("the password is in the body of SignUp, InitiateAuth and ConfirmForgotPassword only", async () => {
    for (const op of Object.keys(OPS)) {
      const { calls } = await run(op, happy[op]!);
      const holdsPassword = calls[0]!.rawBody.includes(NEW_PASSWORD);
      expect(holdsPassword, op).toBe(["signUp", "signIn", "confirmForgotPassword"].includes(op));
    }
  });
});

describe("success shapes", () => {
  it("SignUp returns the sub; an answer without UserSub is unavailable", async () => {
    expect((await run("signUp", () => signUpOk("sub-1"))).result).toEqual({
      ok: true,
      value: { kind: "created", sub: "sub-1" },
    });
    for (const body of [{}, { UserSub: "" }, { UserSub: 5 }, { UserConfirmed: false }]) {
      expect((await run("signUp", () => json(200, body))).result).toEqual({
        ok: false,
        kind: "unavailable",
      });
    }
  });

  it("InitiateAuth returns both tokens and the lifetime", async () => {
    expect((await run("signIn", () => tokens())).result).toEqual({
      ok: true,
      value: {
        kind: "tokens",
        accessToken: PLANTED.accessToken,
        refreshToken: PLANTED.refreshToken,
        expiresInSeconds: 3600,
      },
    });
  });

  it("a tokens answer without a refresh token or an access token is unavailable (no access-only session)", async () => {
    for (const over of [
      { RefreshToken: undefined },
      { RefreshToken: "" },
      { AccessToken: undefined },
      { AccessToken: "" },
    ]) {
      expect((await run("signIn", () => tokens(over))).result).toEqual({
        ok: false,
        kind: "unavailable",
      });
    }
  });

  it.each([59, 86_401, 0, -5, 3600.5, "3600", null])("ExpiresIn %j is unavailable", async (v) => {
    expect((await run("signIn", () => tokens({ ExpiresIn: v }))).result).toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  it.each([60, 86_400])("ExpiresIn %i is accepted", async (v) => {
    expect((await run("signIn", () => tokens({ ExpiresIn: v }))).result).toMatchObject({
      ok: true,
    });
  });

  it("a challenge is totp or other, and the Session string never leaves the adapter", async () => {
    const totp = await run("signIn", () => challenge("SOFTWARE_TOKEN_MFA"));
    expect(totp.result).toEqual({ ok: true, value: { kind: "challenge", challenge: "totp" } });
    const other = await run("signIn", () => challenge("NEW_PASSWORD_REQUIRED"));
    expect(other.result).toEqual({ ok: true, value: { kind: "challenge", challenge: "other" } });
    expect(JSON.stringify([totp.result, other.result])).not.toContain(PLANTED.session);
  });

  it("an answer with neither tokens nor a challenge is unavailable", async () => {
    expect((await run("signIn", () => json(200, {}))).result).toEqual({
      ok: false,
      kind: "unavailable",
    });
  });
});

// One row per documented folding. `err` is the __type, bare or with a namespace.
type Row = [op: string, err: string, expected: IdpResult<unknown>];
const ok = (value: unknown = true): IdpResult<unknown> => ({ ok: true, value });
const bad = (kind: string): IdpResult<unknown> => ({ ok: false, kind }) as IdpResult<unknown>;
const FOLDING: Row[] = [
  ["signUp", "UsernameExistsException", ok({ kind: "exists" })],
  ["signUp", "InvalidPasswordException", bad("invalid_password")],
  ["signUp", "LimitExceededException", bad("rate_limited")],
  ["signUp", "TooManyRequestsException", bad("rate_limited")],
  ["signUp", "InvalidParameterException", bad("unavailable")],
  ["signUp", "SomethingElseException", bad("unavailable")],

  ["confirmSignUp", "CodeMismatchException", bad("invalid_code")],
  ["confirmSignUp", "UserNotFoundException", bad("invalid_code")],
  ["confirmSignUp", "NotAuthorizedException", bad("invalid_code")],
  ["confirmSignUp", "AliasExistsException", bad("invalid_code")],
  ["confirmSignUp", "ExpiredCodeException", bad("expired_code")],
  ["confirmSignUp", "LimitExceededException", bad("rate_limited")],
  ["confirmSignUp", "TooManyFailedAttemptsException", bad("rate_limited")],
  ["confirmSignUp", "TooManyRequestsException", bad("rate_limited")],
  ["confirmSignUp", "SomethingElseException", bad("unavailable")],

  ["resendConfirmationCode", "UserNotFoundException", ok()],
  ["resendConfirmationCode", "InvalidParameterException", ok()],
  ["resendConfirmationCode", "NotAuthorizedException", ok()],
  ["resendConfirmationCode", "CodeDeliveryFailureException", ok()],
  // Round 4: a trigger that refuses (the guard of functions/cognito-messages) must not tell a known
  // address from an unknown one.
  ["resendConfirmationCode", "UserLambdaValidationException", ok()],
  ["resendConfirmationCode", "LimitExceededException", bad("rate_limited")],
  ["resendConfirmationCode", "TooManyRequestsException", bad("rate_limited")],
  ["resendConfirmationCode", "SomethingElseException", bad("unavailable")],

  ["signIn", "UserNotFoundException", bad("denied")],
  ["signIn", "NotAuthorizedException", bad("denied")],
  ["signIn", "PasswordResetRequiredException", bad("denied")],
  ["signIn", "UserNotConfirmedException", bad("not_confirmed")],
  ["signIn", "LimitExceededException", bad("rate_limited")],
  ["signIn", "TooManyRequestsException", bad("rate_limited")],
  ["signIn", "SomethingElseException", bad("unavailable")],

  ["forgotPassword", "UserNotFoundException", ok()],
  ["forgotPassword", "InvalidParameterException", ok()],
  ["forgotPassword", "NotAuthorizedException", ok()],
  ["forgotPassword", "CodeDeliveryFailureException", ok()],
  ["forgotPassword", "UserLambdaValidationException", ok()],
  ["forgotPassword", "LimitExceededException", bad("rate_limited")],
  ["forgotPassword", "TooManyRequestsException", bad("rate_limited")],
  ["forgotPassword", "SomethingElseException", bad("unavailable")],

  ["confirmForgotPassword", "CodeMismatchException", bad("invalid_code")],
  ["confirmForgotPassword", "UserNotFoundException", bad("invalid_code")],
  ["confirmForgotPassword", "NotAuthorizedException", bad("invalid_code")],
  ["confirmForgotPassword", "AliasExistsException", bad("invalid_code")],
  ["confirmForgotPassword", "ExpiredCodeException", bad("expired_code")],
  ["confirmForgotPassword", "InvalidPasswordException", bad("invalid_password")],
  ["confirmForgotPassword", "LimitExceededException", bad("rate_limited")],
  ["confirmForgotPassword", "TooManyFailedAttemptsException", bad("rate_limited")],
  ["confirmForgotPassword", "SomethingElseException", bad("unavailable")],

  ["revokeRefreshToken", "LimitExceededException", bad("rate_limited")],
  ["revokeRefreshToken", "UnauthorizedClientException", bad("unavailable")],
  ["revokeRefreshToken", "SomethingElseException", bad("unavailable")],
];

describe("the folding table (one test per row)", () => {
  it.each(FOLDING)("%s: %s", async (op, err, expected) => {
    expect((await run(op, () => cognitoError(err))).result).toEqual(expected);
    // The namespaced form of the same type folds the same way.
    expect(
      (await run(op, () => cognitoError(`com.amazonaws.cognito.identity.idp.model#${err}`))).result,
    ).toEqual(expected);
  });

  it("an unknown type on a 200 or on a 5xx, and a 400 without a type, are unavailable", async () => {
    for (const op of Object.keys(OPS)) {
      expect((await run(op, () => cognitoError("UserNotFoundException", 500))).result, op).toEqual(
        bad("unavailable"),
      );
      expect((await run(op, () => json(400, {}))).result, op).toEqual(bad("unavailable"));
      expect(
        (await run(op, () => json(403, { __type: "AccessDeniedException" }))).result,
        op,
      ).toEqual(bad("unavailable"));
    }
  });

  it("the enumeration pairs fold to one answer", async () => {
    const same = async (op: string, a: string, b: string) =>
      expect((await run(op, () => cognitoError(a))).result).toEqual(
        (await run(op, () => cognitoError(b))).result,
      );
    await same("signIn", "UserNotFoundException", "NotAuthorizedException");
    await same("forgotPassword", "UserNotFoundException", "CodeDeliveryFailureException");
    // Round 4: the refusal of the trigger (an existing address asked through a client that may not)
    // looks like an unknown address.
    await same("forgotPassword", "UserNotFoundException", "UserLambdaValidationException");
    await same("resendConfirmationCode", "UserNotFoundException", "UserLambdaValidationException");
    await same("resendConfirmationCode", "UserNotFoundException", "NotAuthorizedException");
    await same("confirmSignUp", "UserNotFoundException", "CodeMismatchException");
    await same("confirmForgotPassword", "UserNotFoundException", "CodeMismatchException");
    // and a success looks like an unknown user for the two "if an account exists" operations
    expect((await run("forgotPassword", happy["forgotPassword"]!)).result).toEqual(
      (await run("forgotPassword", () => cognitoError("UserNotFoundException"))).result,
    );
  });
});

// Round 4 (security review, low): the trigger refusing is folded to "ok" so the page cannot tell known
// from unknown, but it is also a fact for an alarm: the observer is told, once, with a fixed kind and
// the operation name, and nothing else (no e-mail, no text of the answer).
describe("a refusing trigger is observed", () => {
  const observed = async (op: string, err: string) => {
    const facts: unknown[] = [];
    const { fetchImpl } = recording(() => cognitoError(err));
    const provider = cognitoIdentityProvider(POOL, CLIENTS, fetchImpl, (fact) => facts.push(fact));
    const result = await OPS[op]!.call(provider);
    return { result, facts };
  };

  it.each([
    ["forgotPassword", "forgotPassword"],
    ["resendConfirmationCode", "resendConfirmationCode"],
  ])(
    "%s: UserLambdaValidationException is ok and reported as trigger_refused",
    async (op, name) => {
      for (const err of [
        "UserLambdaValidationException",
        "com.amazonaws.cognito.identity.idp.model#UserLambdaValidationException",
      ]) {
        const { result, facts } = await observed(op, err);
        expect(result).toEqual({ ok: true, value: true });
        expect(facts).toEqual([{ op: name, kind: "trigger_refused" }]);
      }
    },
  );

  it("other answers, and other operations, report nothing", async () => {
    for (const [op, err] of [
      ["forgotPassword", "UserNotFoundException"],
      ["forgotPassword", "LimitExceededException"],
      ["resendConfirmationCode", "CodeDeliveryFailureException"],
      ["confirmForgotPassword", "UserLambdaValidationException"],
      ["signUp", "UserLambdaValidationException"],
      ["signIn", "UserLambdaValidationException"],
    ] as const) {
      expect((await observed(op, err)).facts, `${op} ${err}`).toEqual([]);
    }
  });

  it("an observer that throws changes nothing", async () => {
    const { fetchImpl } = recording(() => cognitoError("UserLambdaValidationException"));
    const provider = cognitoIdentityProvider(POOL, CLIENTS, fetchImpl, () => {
      throw new Error(`boom ${PLANTED.email}`);
    });
    expect(await provider.forgotPassword(EMAIL)).toEqual({ ok: true, value: true });
  });

  it("without an observer the folding is the same", async () => {
    expect(
      (await run("forgotPassword", () => cognitoError("UserLambdaValidationException"))).result,
    ).toEqual(ok());
  });
});

describe("failures of the transport are unavailable", () => {
  it.each(Object.keys(OPS))(
    "%s: a 502, a non-JSON body, an oversized body, a throwing fetch",
    async (op) => {
      const unavailable = bad("unavailable");
      expect((await run(op, () => json(502, "Bad Gateway"))).result).toEqual(unavailable);
      expect((await run(op, () => json(200, "<html>not json"))).result).toEqual(unavailable);
      expect((await run(op, () => json(200, `{"pad":"${"x".repeat(17_000)}"}`))).result).toEqual(
        unavailable,
      );
      const throwing = cognitoIdentityProvider(POOL, CLIENTS, (() => {
        throw new Error(`boom ${PLANTED.password}`);
      }) as typeof fetch);
      expect(await OPS[op]!.call(throwing)).toEqual(unavailable);
      const rejecting = cognitoIdentityProvider(POOL, CLIENTS, (() =>
        Promise.reject(new Error(`boom ${PLANTED.password}`))) as typeof fetch);
      expect(await OPS[op]!.call(rejecting)).toEqual(unavailable);
    },
  );

  it("a fetch that never resolves ends as unavailable after 5 seconds", async () => {
    vi.useFakeTimers();
    const never = cognitoIdentityProvider(
      POOL,
      CLIENTS,
      (() => new Promise(() => {})) as typeof fetch,
    );
    const pending = OPS["signIn"]!.call(never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual(bad("unavailable"));
  });

  it("the request carries an abort signal of 5 seconds", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await run("signIn", happy["signIn"]!);
    expect(spy).toHaveBeenCalledWith(5000);
  });
});

describe("secrets", () => {
  it("planted secrets in answers and requests are in no returned value, error or inspection", async () => {
    const collected: unknown[] = [];
    const sinks = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const answers: Array<() => Response> = [
      () => cognitoError("NotAuthorizedException"),
      () => cognitoError("UserNotFoundException"),
      () => cognitoError("CodeMismatchException"),
      () => cognitoError("InvalidPasswordException"),
      () => cognitoError("LimitExceededException"),
      () => json(500, { message: PLANTED.session }),
      () => challenge("SOFTWARE_TOKEN_MFA"),
      () => json(200, `${PLANTED.session} ${PLANTED.password}`),
    ];
    for (const answer of answers) {
      const { fetchImpl } = recording(answer);
      const provider = cognitoIdentityProvider(POOL, CLIENTS, fetchImpl);
      collected.push(inspect(provider, { depth: 6 }));
      collected.push(
        await provider.signUp({
          email: PLANTED.email,
          password: PLANTED.password,
          name: "Planted",
          locale: "en",
        }),
        await provider.confirmSignUp({ email: PLANTED.email, code: PLANTED.code }),
        await provider.resendConfirmationCode(PLANTED.email),
        await provider.signIn({ email: PLANTED.email, password: PLANTED.password }),
        await provider.forgotPassword(PLANTED.email),
        await provider.confirmForgotPassword({
          email: PLANTED.email,
          code: PLANTED.code,
          newPassword: PLANTED.password,
        }),
        await provider.revokeRefreshToken(PLANTED.refreshToken),
      );
    }
    const all = JSON.stringify(collected);
    for (const secret of [
      PLANTED.password,
      PLANTED.code,
      PLANTED.session,
      PLANTED.refreshToken,
      SIGN_UP.clientSecret,
      CUSTOMER.clientSecret,
    ]) {
      expect(all).not.toContain(secret);
    }
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  });

  it("the factory keeps no pool, token or client id where inspect can see it", () => {
    const provider = cognitoIdentityProvider(POOL, CLIENTS, (() =>
      Promise.resolve(emptyOk())) as typeof fetch);
    const shown = inspect(provider, { depth: 8, showHidden: true });
    expect(shown).not.toContain(POOL.clientId);
    expect(shown).not.toContain(POOL.userPoolId);
    expect(shown).not.toContain(SIGN_UP.clientId);
    expect(shown).not.toContain(SIGN_UP.clientSecret);
    expect(shown).not.toContain(CUSTOMER.clientSecret);
  });
});

describe("the sources", () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const code = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it.each(["identity.ts", "cognito-identity.ts"])(
    "%s names no environment, console, SDK or framework",
    (f) => {
      const text = code(f);
      for (const banned of [
        /process\.env/,
        /\bconsole\b/,
        /@aws-sdk/,
        /@smithy/,
        /from\s+["']next/,
        /from\s+["']react/,
        /["']@tc\/aws/,
      ]) {
        expect(text).not.toMatch(banned);
      }
    },
  );
});
