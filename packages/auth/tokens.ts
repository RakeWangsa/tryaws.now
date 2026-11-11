import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  FetchError,
  JwksNotAvailableInCacheError,
  JwtExpiredError,
  NonRetryableFetchError,
  WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import type { JwksCache } from "aws-jwt-verify/jwk";
import type { PoolConfig } from "./config";

export interface VerifiedToken {
  readonly sub: string;
  readonly issuedAt: Date; // iat
  readonly authTime: Date; // auth_time
  readonly expiresAt: Date; // exp
  // The `amr` claim (authentication methods) as a list of strings; [] when absent. The admin check
  // reads it for the second factor (6.2).
  readonly amr: readonly string[];
}

export type TokenOutcome =
  | { readonly ok: true; readonly token: VerifiedToken }
  | {
      readonly ok: false;
      readonly error: "unauthenticated" | "upstream_unavailable";
      readonly reason: "token_invalid" | "token_expired" | "unavailable";
    };

export interface AccessTokenVerifier {
  verify(token: string | undefined): Promise<TokenOutcome>;
}

// A Cognito access token is about 1 KB; anything this long is not one and is not worth a parse.
const MAX_TOKEN_LENGTH = 8192;

const INVALID: TokenOutcome = Object.freeze({
  ok: false,
  error: "unauthenticated",
  reason: "token_invalid",
});
const EXPIRED: TokenOutcome = Object.freeze({
  ok: false,
  error: "unauthenticated",
  reason: "token_expired",
});
const UNAVAILABLE: TokenOutcome = Object.freeze({
  ok: false,
  error: "upstream_unavailable",
  reason: "unavailable",
});

// R16: only these mean "the key set could not be had", which is a fault of ours or of AWS and must
// not log the customer out. Everything else, including an error we do not know, is no session.
function outcomeOfError(error: unknown): TokenOutcome {
  if (error instanceof JwtExpiredError) return EXPIRED;
  if (
    error instanceof NonRetryableFetchError ||
    error instanceof FetchError ||
    error instanceof JwksNotAvailableInCacheError ||
    error instanceof WaitPeriodNotYetEndedJwkError
  ) {
    return UNAVAILABLE;
  }
  return INVALID;
}

function secondsToDate(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : undefined;
}

// One verifier per pool, created once per process: the JWKS cache and the penalty box live in it.
// The raw-JWT-in-errors option stays at its default (off), and the library's message is never passed on
// (R14): the caller gets an enum, nothing else. `jwksCache` is for tests.
export function createAccessTokenVerifier(
  pool: PoolConfig,
  deps?: { jwksCache?: JwksCache },
): AccessTokenVerifier {
  const verifier = CognitoJwtVerifier.create(
    { userPoolId: pool.userPoolId, tokenUse: "access", clientId: pool.clientId },
    deps?.jwksCache ? { jwksCache: deps.jwksCache } : undefined,
  );

  return {
    async verify(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
        return INVALID;
      try {
        const payload: Record<string, unknown> = await verifier.verify(token);
        const sub = payload["sub"];
        const issuedAt = secondsToDate(payload["iat"]);
        const authTime = secondsToDate(payload["auth_time"]);
        const expiresAt = secondsToDate(payload["exp"]);
        if (typeof sub !== "string" || sub.length === 0 || !issuedAt || !authTime || !expiresAt)
          return INVALID;
        const rawAmr = payload["amr"];
        const amr = Array.isArray(rawAmr)
          ? rawAmr.filter((x): x is string => typeof x === "string")
          : [];
        return { ok: true, token: { sub, issuedAt, authTime, expiresAt, amr } };
      } catch (error) {
        return outcomeOfError(error);
      }
    },
  };
}
