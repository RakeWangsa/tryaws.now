import { authenticateAdmin, type AdminSessionDeps } from "./admin";
import type { PoolConfig } from "./config";
import { ADMIN_ACCESS_COOKIE } from "./cookies";

// 6.2: the admin signs in with the password and a TOTP code, always. Cognito's own flow does it in two
// calls (InitiateAuth, then RespondToAuthChallenge with SOFTWARE_TOKEN_MFA); this form sends both
// values at once and the function makes the two calls. There is no way in without the second factor:
// a Cognito answer that is not the TOTP challenge is a refusal, and the session that comes out is
// verified with the same checks as every later request before any cookie is set.
//
// WPU-Z15, ruling of 2026-11-13: this flow IS the proof of TOTP (the access token carries no `amr`,
// admin.ts). The admin pool requires TOTP, and the session is created only from the tokens that
// answer the SOFTWARE_TOKEN_MFA challenge of the same flow. Every other path is refused (R16): tokens
// without a challenge, another challenge (MFA_SETUP, NEW_PASSWORD_REQUIRED, ...), and an answer to the
// code that is not plain tokens.

export type StartResult =
  | { readonly kind: "mfa_challenge"; readonly session: string }
  | { readonly kind: "other_challenge" } // a direct result, MFA_SETUP, NEW_PASSWORD_REQUIRED, ...
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

export type ConfirmResult =
  | { readonly kind: "signed_in"; readonly accessToken: string; readonly expiresInSeconds: number }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

export interface AdminSignInPort {
  start(email: string, password: string): Promise<StartResult>;
  confirm(email: string, session: string, code: string): Promise<ConfirmResult>;
}

export interface AdminSignInInput {
  readonly email: string;
  readonly password: string;
  readonly code: string;
  // CloudFront-Viewer-Address of the request: the allowlist is checked before Cognito is asked.
  readonly viewerAddress: string | null | undefined;
}

// One answer for a wrong password, a wrong code, an unknown user, a disabled admin and a missing
// second factor: the screen must not tell which part was wrong (R14, no enumeration).
export type AdminSignInOutcome =
  | {
      readonly ok: true;
      readonly adminId: string;
      readonly accessToken: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: "invalid" | "denied" | "unavailable" };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const CODE = /^\d{6}$/;
const MAX_PASSWORD = 256;
const MAX_EMAIL = 254;
const ALL_ROLES = ["support", "finance", "ops", "superadmin"] as const;

// The shape check of the form (R9: validate). The repository has no zod and R17 forbids a new
// dependency without a recorded reason, so the schema is this function; the action calls it first.
export function isValidSignInShape(input: {
  email: unknown;
  password: unknown;
  code: unknown;
}): boolean {
  const { email, password, code } = input;
  return (
    typeof email === "string" &&
    email.length <= MAX_EMAIL &&
    EMAIL.test(email) &&
    typeof password === "string" &&
    password.length > 0 &&
    password.length <= MAX_PASSWORD &&
    typeof code === "string" &&
    CODE.test(code)
  );
}

export async function signInAdmin(
  port: AdminSignInPort,
  deps: AdminSessionDeps,
  input: AdminSignInInput,
): Promise<AdminSignInOutcome> {
  // Read once into locals.
  const { email, password, code, viewerAddress } = input;
  if (!isValidSignInShape({ email, password, code })) return { ok: false, reason: "invalid" };

  try {
    // The address is checked first: from outside the allowlist Cognito is not even asked. The cookie
    // part of this probe is empty on purpose; only the address step is looked at here.
    const probe = await authenticateAdmin(
      { ...deps, onDenied: undefined },
      { cookieHeader: null, viewerAddress },
      ALL_ROLES,
    );
    if (!probe.ok && probe.reason === "ip_not_allowed") return { ok: false, reason: "denied" };

    const first = await port.start(email, password);
    if (first.kind === "unavailable") return { ok: false, reason: "unavailable" };
    if (first.kind !== "mfa_challenge") return { ok: false, reason: "denied" };

    const second = await port.confirm(email, first.session, code);
    if (second.kind === "unavailable") return { ok: false, reason: "unavailable" };
    if (second.kind !== "signed_in") return { ok: false, reason: "denied" };

    // The tokens answer the TOTP challenge of this flow. The session is verified as every request is:
    // the allowlist, the token of the admin pool and its age, an active admin.
    const checked = await authenticateAdmin(
      deps,
      { cookieHeader: `${ADMIN_ACCESS_COOKIE}=${second.accessToken}`, viewerAddress },
      ALL_ROLES,
    );
    if (!checked.ok) {
      return {
        ok: false,
        reason: checked.error === "upstream_unavailable" ? "unavailable" : "denied",
      };
    }
    const now = (deps.clock ?? { now: () => new Date() }).now().getTime();
    const seconds = Number.isFinite(second.expiresInSeconds) ? second.expiresInSeconds : 0;
    return {
      ok: true,
      adminId: checked.actor.adminId,
      accessToken: second.accessToken,
      expiresAt: new Date(now + seconds * 1000),
    };
  } catch {
    // The text of a thrown error may hold a password or a token (R14): none is kept.
    return { ok: false, reason: "unavailable" };
  }
}

const TIMEOUT_MS = 5000;
const MAX_ANSWER_CHARS = 16_384;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The same unsigned public form as the refresh port: plain fetch, no SDK, no SigV4, no secret (R3).
// The admin app client allows exactly the flows used here (infra/stacks/auth.ts adminClient,
// explicitAuthFlows; pinned by tests/repo/infra-rules.test.mjs), has no client secret, and the pool
// requires TOTP with no self sign-up. VERIFY on staging with a real admin.
export function cognitoAdminSignInPort(
  pool: PoolConfig,
  fetchImpl: typeof fetch = fetch,
): AdminSignInPort {
  const url = `https://cognito-idp.${pool.region}.amazonaws.com/`;

  // Returns the parsed body and the Cognito error type (undefined on success), or null when the
  // answer cannot be trusted. Never keeps a message.
  async function call(
    target: "InitiateAuth" | "RespondToAuthChallenge",
    body: unknown,
  ): Promise<{ body: Record<string, unknown>; errorType?: string } | null> {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (text.length > MAX_ANSWER_CHARS) return null;
      const parsed = asRecord(JSON.parse(text));
      if (!parsed) return null;
      if (res.status === 200) return { body: parsed };
      if (res.status === 400) {
        const type = parsed["__type"];
        return typeof type === "string" ? { body: parsed, errorType: type } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  // The user-caused errors of Cognito: a wrong password, a wrong code, an unknown or disabled user.
  const DENIED =
    /(NotAuthorizedException|CodeMismatchException|ExpiredCodeException|UserNotFoundException)$/;

  return {
    async start(email, password) {
      const answer = await call("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: pool.clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });
      if (answer === null) return { kind: "unavailable" };
      if (answer.errorType !== undefined) {
        return DENIED.test(answer.errorType) ? { kind: "denied" } : { kind: "unavailable" };
      }
      const session = answer.body["Session"];
      if (
        answer.body["ChallengeName"] === "SOFTWARE_TOKEN_MFA" &&
        typeof session === "string" &&
        session.length > 0
      ) {
        return { kind: "mfa_challenge", session };
      }
      return { kind: "other_challenge" };
    },

    async confirm(email, session, code) {
      const answer = await call("RespondToAuthChallenge", {
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        ClientId: pool.clientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
      });
      if (answer === null) return { kind: "unavailable" };
      if (answer.errorType !== undefined) {
        return DENIED.test(answer.errorType) ? { kind: "denied" } : { kind: "unavailable" };
      }
      // Another challenge after the code is not a sign-in, even when tokens come with it (R16).
      if (answer.body["ChallengeName"] !== undefined) return { kind: "denied" };
      const result = asRecord(answer.body["AuthenticationResult"]);
      const accessToken = result?.["AccessToken"];
      const expiresIn = result?.["ExpiresIn"];
      if (
        typeof accessToken !== "string" ||
        accessToken.length === 0 ||
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn)
      ) {
        return { kind: "denied" };
      }
      return { kind: "signed_in", accessToken, expiresInSeconds: expiresIn };
    },
  };
}
