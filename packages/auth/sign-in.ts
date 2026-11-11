import { ACCESS_COOKIE, isCookieValue, sessionCookieSpecs, type CookieSpec } from "./cookies";
import { authenticateCustomer, type SessionDeps } from "./session";
import type { Clock, CustomerSession, Denied } from "./types";

export type SignInDeps = SessionDeps & {
  readonly clock: Clock;
  readonly refreshMaxAgeSeconds: number;
};

export type SignedIn =
  { readonly ok: true; readonly session: CustomerSession; readonly cookies: CookieSpec[] } | Denied;

// A successful sign-in at the identity provider is never trusted on its own (WP2-T2, Review Focus 2).
// The access token goes through authenticateCustomer first: signature, issuer, client_id, token_use,
// expiry, the customer row of the sub, sessions_valid_after and the status. Only then are the cookie
// specs built, from this package's own names and checks; the app sets them and nothing else. A denial
// carries no cookie and no token. Never throws (R16); the customer id is the id of the row (R8).
export async function completeSignIn(
  deps: SignInDeps,
  tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number },
): Promise<SignedIn> {
  const deny = (error: Denied["error"], reason: Denied["reason"]): Denied => {
    try {
      deps.onDenied?.(reason);
    } catch {
      // The hook is for counting; its failure must not change the outcome.
    }
    return { ok: false, error, reason };
  };

  try {
    // Shape first: a value that cannot be a cookie never reaches the header built below, which also
    // keeps a separator in a token from adding a cookie of its own to it.
    if (
      typeof tokens !== "object" ||
      tokens === null ||
      !isCookieValue(tokens.accessToken) ||
      !isCookieValue(tokens.refreshToken) ||
      !Number.isInteger(tokens.expiresInSeconds) ||
      tokens.expiresInSeconds < 1
    ) {
      return deny("unauthenticated", "token_invalid");
    }

    const outcome = await authenticateCustomer(deps, `${ACCESS_COOKIE}=${tokens.accessToken}`);
    if (!outcome.ok) return outcome;

    const cookies = sessionCookieSpecs(
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: new Date(deps.clock.now().getTime() + tokens.expiresInSeconds * 1000),
      },
      deps.clock,
      deps.refreshMaxAgeSeconds,
    );
    return { ok: true, session: outcome.session, cookies };
  } catch {
    return deny("upstream_unavailable", "unavailable");
  }
}
