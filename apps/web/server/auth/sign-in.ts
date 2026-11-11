import { parseSignInForm } from "@tc/core";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth, userAgentOf } from "./common.ts";
import { landingAfterSignIn, landingPath } from "./landing.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * Sign-in. A wrong password, an unknown address, an unconfirmed address and a customer row that is
 * missing or revoked are one `sign_in_failed`. A token is never trusted on the provider's word: the
 * cookies come only from completeSignIn, which checks the token against the customer row first.
 */
export async function signInCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  // 1. Authenticate: public by design; a signed-in customer goes on to the panel.
  const current = await ctx.ports.currentSession();
  if (current !== null) return done(landingPath(localeOf(form), form["next"]));

  // 2. Authorize.
  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  // 3. Validate. The password gets no policy here (it would only teach the policy).
  const parsed = parseSignInForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const { email, password } = parsed.value;

  // 4. Rate limit: the pair of address and email, the address, and the email.
  const limit = await ctx.ports.limit("signin", { ip: guard.ip, email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  // 5. Execute.
  const answer = await guard.identity.signIn({ email, password });
  if (!answer.ok) {
    logAuth(ctx, "auth.signin", answer.kind);
    switch (answer.kind) {
      case "rate_limited":
        return failure(ctx, "rate_limited", { form, retryAfterSeconds: 60 });
      case "unavailable":
        return failure(ctx, "unavailable", { form });
      default:
        return failure(ctx, "sign_in_failed", { form });
    }
  }
  if (answer.value.kind === "challenge") {
    // TOTP is switched on in WP2-T5, so nobody can have it yet (open point 16): refuse closed.
    logAuth(ctx, "auth.signin", "challenge");
    return failure(ctx, "totp_unsupported", { form });
  }

  const signedIn = await ctx.ports.completeSignIn({
    accessToken: answer.value.accessToken,
    refreshToken: answer.value.refreshToken,
    expiresInSeconds: answer.value.expiresInSeconds,
  });
  if (!signedIn.ok) {
    logAuth(ctx, "auth.signin", signedIn.reason);
    if (signedIn.reason === "suspended") return failure(ctx, "suspended", { form });
    if (signedIn.reason === "unavailable" || signedIn.reason === "not_configured") {
      return failure(ctx, "unavailable", { form });
    }
    return failure(ctx, "sign_in_failed", { form });
  }

  // 6. Audit: a row for the customer. If it cannot be written, no cookie is set (R16).
  const userAgent = userAgentOf(ctx);
  let phoneVerified: boolean;
  try {
    ({ phoneVerified } = await ctx.ports.recordSignIn(signedIn.session, {
      ip: guard.ip,
      ...(userAgent !== undefined ? { userAgent } : {}),
    }));
  } catch {
    logAuth(ctx, "auth.signin", "audit_failed");
    return failure(ctx, "unavailable", { form });
  }

  logAuth(ctx, "auth.signin", "ok");
  return done(landingAfterSignIn(localeOf(form), form["next"], phoneVerified), {
    setCookies: signedIn.cookies,
  });
}
