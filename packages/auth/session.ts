import type { CustomerIdentity } from "@tc/db";
import { ACCESS_COOKIE, parseCookieHeader } from "./cookies";
import type { AccessTokenVerifier } from "./tokens";
import type { AuthReason, CustomerSession, Denied } from "./types";

export interface SessionDeps {
  readonly verifier: AccessTokenVerifier;
  // Production: (sub) => withTx((tx) => lookupCustomerBySub(tx, sub)); built in configureAuth.
  readonly lookup: (sub: string) => Promise<CustomerIdentity | null>;
  // Gets an enum only (R14). A hook that throws is ignored: it cannot change the outcome.
  readonly onDenied?: (reason: AuthReason) => void;
}

export type SessionOutcome = { readonly ok: true; readonly session: CustomerSession } | Denied;

// 6.1, one request: cookie, token, customer row, revocation, status, session. A failure stops the
// rest. It never throws and never returns a session unless every step passed (R16). The customer id
// is the id of the row found by the verified sub; no other claim, cookie or header is read (R8).
export async function authenticateCustomer(
  deps: SessionDeps,
  cookieHeader: string | null | undefined,
): Promise<SessionOutcome> {
  const deny = (error: Denied["error"], reason: AuthReason): Denied => {
    try {
      deps.onDenied?.(reason);
    } catch {
      // The hook is for counting; its failure must not turn a refusal into anything else.
    }
    return { ok: false, error, reason };
  };

  try {
    // 1. The access cookie. The refresh cookie alone is no session.
    const accessToken = parseCookieHeader(cookieHeader).get(ACCESS_COOKIE);
    if (accessToken === undefined || accessToken.length === 0) {
      return deny("unauthenticated", "no_cookie");
    }

    // 2. Signature, issuer, client_id, token_use, expiry.
    const verified = await deps.verifier.verify(accessToken);
    if (!verified.ok) return deny(verified.error, verified.reason);
    const { token } = verified;

    // 3. The customer of that sub. A failing lookup is our fault, not the customer's.
    let identity: CustomerIdentity | null;
    try {
      identity = await deps.lookup(token.sub);
    } catch {
      return deny("upstream_unavailable", "unavailable");
    }
    if (identity === null || identity === undefined) {
      return deny("unauthenticated", "unknown_subject");
    }

    // 4. Sign-out everywhere, password change and suspension set sessions_valid_after. Written so
    // that a cut-off that is not a valid time refuses (NaN makes the comparison false).
    if (identity.sessionsValidAfter !== null) {
      const cutOff = identity.sessionsValidAfter.getTime();
      if (!(token.issuedAt.getTime() >= cutOff)) return deny("unauthenticated", "revoked");
    }

    // 5. Revocation first, status second: a revoked token of a suspended customer is unauthenticated.
    if (identity.status !== "active") return deny("forbidden", "suspended");

    // 6. Exactly the five fields of section F.
    return {
      ok: true,
      session: {
        customerId: identity.id,
        kycStatus: identity.kycStatus,
        riskTier: identity.riskTier,
        locale: identity.locale,
        signedInAt: token.authTime,
      },
    };
  } catch {
    return deny("upstream_unavailable", "unavailable");
  }
}
