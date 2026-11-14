import type { AuthConfig, ClientCredentials, PoolConfig } from "./config";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionSetCookies,
  parseCookieHeader,
  sessionSetCookies,
  withSessionCookies,
} from "./cookies";
import type { AccessTokenVerifier } from "./tokens";
import type { Clock } from "./types";

// A refresh that needs neither the database nor AWS credentials: it sends the refresh token to Cognito.
export type RefreshResult =
  | { readonly kind: "refreshed"; readonly accessToken: string; readonly refreshToken?: string } // refreshToken only if Cognito rotated it
  | { readonly kind: "rejected" } // Cognito says the refresh token is no longer good
  | { readonly kind: "unavailable" }; // timeout, network, 5xx, malformed answer

export interface RefreshPort {
  refresh(refreshToken: string): Promise<RefreshResult>;
}

const TIMEOUT_MS = 3000;
const MAX_ANSWER_CHARS = 16_384;
const UNAVAILABLE: RefreshResult = Object.freeze({ kind: "unavailable" });
const REJECTED: RefreshResult = Object.freeze({ kind: "rejected" });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// GetTokensFromRefreshToken by plain fetch (open point 12): the unsigned public form of the call. No
// SigV4, no SDK (R1, R3). WPU-X12 round 4: the customer app client has a secret (so Cognito itself
// refuses SignUp, Resend and ForgotPassword through it). The refresh sends the client secret itself in
// the body, over TLS to the one Cognito endpoint: the REFRESH_TOKEN_AUTH flow of InitiateAuth would need
// a SECRET_HASH over the user's sub, which is unknown when only the refresh cookie is left (the access
// cookie expires first, and the refresh token is opaque). The answer has the same AuthenticationResult.
// VERIFY on staging (JOURNEY WPU-X12 round 4): the call is accepted without AWS credentials for this
// client, and with refresh token rotation off it returns no new refresh token. The body of an answer
// is parsed here and never logged or returned; every failure ends as "unavailable" with no text, because
// an error message could carry the refresh token or the secret (R14, R16).
export function cognitoRefreshPort(
  pool: PoolConfig,
  client: ClientCredentials,
  fetchImpl: typeof fetch = fetch,
): RefreshPort {
  const url = `https://cognito-idp.${pool.region}.amazonaws.com/`;
  return {
    async refresh(refreshToken) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
          },
          body: JSON.stringify({
            ClientId: client.clientId,
            ClientSecret: client.clientSecret,
            RefreshToken: refreshToken,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        if (text.length > MAX_ANSWER_CHARS) return UNAVAILABLE;
        const body = asRecord(JSON.parse(text));
        if (!body) return UNAVAILABLE;
        if (res.status === 400) {
          const type = body["__type"];
          // Cognito writes the type bare or as "<namespace>#NotAuthorizedException". A token that was
          // used up by rotation (RefreshTokenReuseException) is as good as revoked, and so is the token
          // of a user who no longer exists (UserNotFoundException): the cookies are cleared instead of
          // the same dead token being tried again on every request.
          return typeof type === "string" &&
            (type.endsWith("NotAuthorizedException") ||
              type.endsWith("RefreshTokenReuseException") ||
              type.endsWith("UserNotFoundException"))
            ? REJECTED
            : UNAVAILABLE;
        }
        if (res.status !== 200) return UNAVAILABLE;
        const result = asRecord(body["AuthenticationResult"]);
        const accessToken = result?.["AccessToken"];
        if (typeof accessToken !== "string" || accessToken.length === 0) return UNAVAILABLE;
        const rotated = result?.["RefreshToken"];
        return typeof rotated === "string" && rotated.length > 0
          ? { kind: "refreshed", accessToken, refreshToken: rotated }
          : { kind: "refreshed", accessToken };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

// The payload of a token read WITHOUT verification. This is the only place in the package where that
// happens, and the result only decides whether to call Cognito: the new token is verified before it
// is stored, and every token is verified on use. Anything unreadable is undefined.
function unverifiedExpiry(token: string): number | undefined {
  try {
    if (token.length > 8192) return undefined;
    const segments = token.split(".");
    if (segments.length !== 3 || !segments[1]) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    const exp = asRecord(payload)?.["exp"];
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

// True when the access cookie is missing and a refresh cookie exists, or when the access token's exp
// is within `windowSeconds` (the boundary is inclusive). An unreadable access token counts as
// "refresh". The refresh cookie's presence is checked by refreshSession, which does nothing without it.
export function needsRefresh(
  cookies: ReadonlyMap<string, string>,
  clock: Clock,
  windowSeconds: number,
): boolean {
  const access = cookies.get(ACCESS_COOKIE);
  if (access === undefined || access === "") return (cookies.get(REFRESH_COOKIE) ?? "") !== "";
  const exp = unverifiedExpiry(access);
  if (exp === undefined) return true;
  return exp * 1000 - clock.now().getTime() <= windowSeconds * 1000;
}

export type RefreshOutcome =
  | { readonly action: "none" } // nothing to do (or Cognito unreachable: keep the cookies)
  | { readonly action: "set"; readonly setCookies: string[]; readonly cookieHeader: string }
  | { readonly action: "clear"; readonly setCookies: string[]; readonly cookieHeader: string };

const NONE: RefreshOutcome = Object.freeze({ action: "none" });

function withoutSessionCookies(cookies: ReadonlyMap<string, string>): string {
  return [...cookies]
    .filter(([name]) => name !== ACCESS_COOKIE && name !== REFRESH_COOKIE)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

// Never throws (R16). Whether a refresh is due is decided by needsRefresh, which the caller asks first.
export async function refreshSession(
  deps: {
    readonly port: RefreshPort;
    readonly verifier: AccessTokenVerifier;
    readonly clock: Clock;
    readonly config: AuthConfig;
  },
  cookieHeader: string | null | undefined,
): Promise<RefreshOutcome> {
  try {
    const cookies = parseCookieHeader(cookieHeader);
    const refreshToken = cookies.get(REFRESH_COOKIE);
    if (refreshToken === undefined || refreshToken === "") return NONE;

    const result = await deps.port.refresh(refreshToken);
    if (result.kind === "rejected") {
      return {
        action: "clear",
        setCookies: clearSessionSetCookies(),
        cookieHeader: withoutSessionCookies(cookies),
      };
    }
    if (result.kind !== "refreshed") return NONE;

    // A token that does not verify is never stored, whatever Cognito said.
    const verified = await deps.verifier.verify(result.accessToken);
    if (!verified.ok) return NONE;

    const tokens = {
      accessToken: result.accessToken,
      ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
      accessExpiresAt: verified.token.expiresAt,
    };
    return {
      action: "set",
      setCookies: sessionSetCookies(tokens, deps.clock, deps.config.refreshCookieMaxAgeSeconds),
      cookieHeader: withSessionCookies(cookieHeader, tokens),
    };
  } catch {
    return NONE;
  }
}
