import { createHmac } from "node:crypto";
import type { PoolConfig, SignUpClientConfig } from "./config";
import type {
  IdentityProvider,
  IdpFailure,
  IdpResult,
  SignInOutcome,
  SignUpOutcome,
} from "./identity";

// The customer pool's public, unsigned operations by plain fetch (open points 1 and 2): no AWS SDK,
// no credentials, no SigV4, no SRP (R1, R3, R17). Two app clients (WPU-X12):
// - the token-issuing customer client (no secret, writeAttributes ["name"]) for sign-in and the token
//   revocation (a refresh token belongs to the client that issued it);
// - the server-only sign-up client (with a secret, the only client that may write email, name and
//   locale) for SignUp, ConfirmSignUp, ResendConfirmationCode and (round 3) ForgotPassword and
//   ConfirmForgotPassword, each with its SecretHash. The secret
//   is used only inside secretHash and is never sent, logged or returned; Node's own HMAC, so no new
//   dependency (R17). Every
// answer is parsed here and never logged or returned: a body or an error text can carry a password, a
// code or a token, so every failure ends as a bare kind and no text of it is kept (R14). Unknown
// shapes, statuses, timeouts and oversized bodies are "unavailable" (R16).
//
// The enumeration rule lives here and again in the action cores (Review Focus 1): the types that
// would tell an existing address from an unknown one fold to one answer per operation.
//
// VERIFY (open point 27): the exact `__type` strings per operation, that PreventUserExistenceErrors
// is on in the app client, that ALLOW_USER_PASSWORD_AUTH is on, whether UserNotConfirmedException is
// masked, the challenge names, ExpiresIn.

const TIMEOUT_MS = 5000;
const MAX_ANSWER_CHARS = 16_384;
const MAX_TOKEN_CHARS = 8192;
const MAX_SUB_CHARS = 128;
const MIN_EXPIRES_IN = 60;
const MAX_EXPIRES_IN = 86_400;

type Answer = { readonly status: number; readonly body: Record<string, unknown> };
type Fold = ReadonlyMap<string, IdpFailure | "ok">;

const unavailable = (): { ok: false; kind: "unavailable" } => ({ ok: false, kind: "unavailable" });
const fail = (kind: IdpFailure): { ok: false; kind: IdpFailure } => ({ ok: false, kind });
const success = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const LIMITS: ReadonlyArray<[string, IdpFailure]> = [
  ["LimitExceededException", "rate_limited"],
  ["TooManyRequestsException", "rate_limited"],
  ["TooManyFailedAttemptsException", "rate_limited"],
];

// A confirmation call: a wrong code, an unknown user, an already confirmed user and an alias clash all
// look like a wrong code.
const CONFIRM: Fold = new Map<string, IdpFailure | "ok">([
  ["CodeMismatchException", "invalid_code"],
  ["UserNotFoundException", "invalid_code"],
  ["NotAuthorizedException", "invalid_code"],
  ["AliasExistsException", "invalid_code"],
  ["ExpiredCodeException", "expired_code"],
  ...LIMITS,
]);
const CONFIRM_RESET: Fold = new Map([...CONFIRM, ["InvalidPasswordException", "invalid_password"]]);
// "If an account exists, a code was sent": the page says the same for every address.
const SEND: Fold = new Map<string, IdpFailure | "ok">([
  ["UserNotFoundException", "ok"],
  ["InvalidParameterException", "ok"],
  ["NotAuthorizedException", "ok"],
  ["CodeDeliveryFailureException", "ok"],
  ...LIMITS,
]);
const SIGN_UP: Fold = new Map<string, IdpFailure | "ok">([
  ["InvalidPasswordException", "invalid_password"],
  ...LIMITS,
]);
const SIGN_IN: Fold = new Map<string, IdpFailure | "ok">([
  ["UserNotFoundException", "denied"],
  ["NotAuthorizedException", "denied"],
  // Folded with the unknown user so that a reset-required account is no oracle either.
  ["PasswordResetRequiredException", "denied"],
  ["UserNotConfirmedException", "not_confirmed"],
  ...LIMITS,
]);
const REVOKE: Fold = new Map<string, IdpFailure | "ok">(LIMITS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Cognito writes the type bare or as "<namespace>#Name".
function typeOf(body: Record<string, unknown>): string | undefined {
  const type = body["__type"];
  return typeof type === "string" ? type.slice(type.lastIndexOf("#") + 1) : undefined;
}

// AWS developer guide, "Computing secret hash values":
// Base64(HMAC_SHA256(key = client secret, message = username + client id)).
export function secretHash(clientSecret: string, username: string, clientId: string): string {
  return createHmac("sha256", clientSecret)
    .update(username + clientId)
    .digest("base64");
}

export function cognitoIdentityProvider(
  pool: PoolConfig,
  signUpClient: SignUpClientConfig,
  fetchImpl: typeof fetch = fetch,
): IdentityProvider {
  const url = `https://cognito-idp.${pool.region}.amazonaws.com/`;
  const clientId = pool.clientId;
  const signUpClientId = signUpClient.clientId;
  const signUpSecret = signUpClient.clientSecret;

  // The client fields of a sign-up call: the sign-up client and the hash for this username. They
  // follow the default ClientId in the body, so they replace it.
  const viaSignUpClient = (username: string): Record<string, unknown> => ({
    ClientId: signUpClientId,
    SecretHash: secretHash(signUpSecret, username, signUpClientId),
  });

  // One POST. Never throws and never rejects; null is "unavailable". The timer is ours as well as the
  // signal's, so a fetch that ignores its signal still ends after TIMEOUT_MS.
  async function post(target: string, body: Record<string, unknown>): Promise<Answer | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    const exchange = (async (): Promise<Answer | null> => {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
          },
          body: JSON.stringify({ ClientId: clientId, ...body }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        if (text.length > MAX_ANSWER_CHARS) return null;
        // Some operations answer 200 with an empty body.
        const parsed = text === "" && res.status === 200 ? {} : asRecord(JSON.parse(text));
        return parsed === undefined ? null : { status: res.status, body: parsed };
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([exchange, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The error half of every operation: only a 400 is folded, the rest is unavailable.
  function folded(answer: Answer, table: Fold): IdpResult<true> | undefined {
    if (answer.status !== 400) return undefined;
    const type = typeOf(answer.body);
    const outcome = type === undefined ? undefined : table.get(type);
    if (outcome === undefined) return undefined;
    return outcome === "ok" ? success(true as const) : fail(outcome);
  }

  async function simple(
    target: string,
    body: Record<string, unknown>,
    table: Fold,
  ): Promise<IdpResult<true>> {
    const answer = await post(target, body);
    if (answer === null) return unavailable();
    if (answer.status === 200) return success(true as const);
    return folded(answer, table) ?? unavailable();
  }

  return {
    async signUp(i): Promise<IdpResult<SignUpOutcome>> {
      const answer = await post("SignUp", {
        ...viaSignUpClient(i.email),
        Username: i.email,
        Password: i.password,
        // No phone_number: the phone is verified by our own OTP (open point 15).
        UserAttributes: [
          { Name: "email", Value: i.email },
          { Name: "name", Value: i.name },
          { Name: "locale", Value: i.locale },
        ],
      });
      if (answer === null) return unavailable();
      if (answer.status === 200) {
        const sub = answer.body["UserSub"];
        return typeof sub === "string" && sub.length > 0 && sub.length <= MAX_SUB_CHARS
          ? success({ kind: "created", sub })
          : unavailable();
      }
      // An existing address looks like a new one to the caller.
      if (answer.status === 400 && typeOf(answer.body) === "UsernameExistsException") {
        return success({ kind: "exists" });
      }
      const f = folded(answer, SIGN_UP);
      return f !== undefined && !f.ok ? f : unavailable();
    },

    confirmSignUp: (i) =>
      simple(
        "ConfirmSignUp",
        { ...viaSignUpClient(i.email), Username: i.email, ConfirmationCode: i.code },
        CONFIRM,
      ),

    resendConfirmationCode: (email) =>
      simple("ResendConfirmationCode", { ...viaSignUpClient(email), Username: email }, SEND),

    async signIn(i): Promise<IdpResult<SignInOutcome>> {
      const answer = await post("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: i.email, PASSWORD: i.password },
      });
      if (answer === null) return unavailable();
      if (answer.status === 200) {
        const result = asRecord(answer.body["AuthenticationResult"]);
        if (result !== undefined) {
          const accessToken = result["AccessToken"];
          const refreshToken = result["RefreshToken"];
          const expiresIn = result["ExpiresIn"];
          if (
            typeof accessToken !== "string" ||
            accessToken.length === 0 ||
            accessToken.length > MAX_TOKEN_CHARS ||
            typeof refreshToken !== "string" ||
            refreshToken.length === 0 ||
            refreshToken.length > MAX_TOKEN_CHARS ||
            typeof expiresIn !== "number" ||
            !Number.isInteger(expiresIn) ||
            expiresIn < MIN_EXPIRES_IN ||
            expiresIn > MAX_EXPIRES_IN
          ) {
            return unavailable();
          }
          return success({
            kind: "tokens",
            accessToken,
            refreshToken,
            expiresInSeconds: expiresIn,
          });
        }
        const name = answer.body["ChallengeName"];
        if (typeof name === "string" && name.length > 0) {
          return success({
            kind: "challenge",
            challenge: name === "SOFTWARE_TOKEN_MFA" ? "totp" : "other",
          });
        }
        return unavailable();
      }
      const f = folded(answer, SIGN_IN);
      return f !== undefined && !f.ok ? f : unavailable();
    },

    // WPU-X12 round 3: the reset goes through the sign-up client too, so the custom-message trigger can
    // refuse a customer reset code asked for through the public client (functions/cognito-messages).
    forgotPassword: (email) =>
      simple("ForgotPassword", { ...viaSignUpClient(email), Username: email }, SEND),

    confirmForgotPassword: (i) =>
      simple(
        "ConfirmForgotPassword",
        {
          ...viaSignUpClient(i.email),
          Username: i.email,
          ConfirmationCode: i.code,
          Password: i.newPassword,
        },
        CONFIRM_RESET,
      ),

    revokeRefreshToken: (refreshToken) => simple("RevokeToken", { Token: refreshToken }, REVOKE),
  };
}
