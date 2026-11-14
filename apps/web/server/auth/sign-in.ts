import { parseOtpCode, parseSignInForm } from "@tc/core";
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
  // WPU-X11: the authenticator code, optional (only a customer with TOTP on is asked for it).
  const rawCode = form["totpCode"];
  let totpCode: string | undefined;
  if (rawCode !== undefined && rawCode !== "") {
    const code = typeof rawCode === "string" ? parseOtpCode(rawCode) : null;
    if (code === null) return failure(ctx, "invalid", { fields: { totpCode: "invalid" }, form });
    totpCode = code;
  }

  // 4. Rate limit: the pair of address and email, the address, and the email.
  const limit = await ctx.ports.limit("signin", { ip: guard.ip, email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  // WPU-X11 round 2: with a code, the attempt is RESERVED before the provider is asked: one atomic count
  // against the wrong-code limit (5 in 15 minutes, 20 a day, per address typed). A check followed by a
  // count would let N parallel guesses all pass the check before any is counted; a reservation cannot be
  // passed more than `limit` times. When the limit is used up the provider is not asked. The refusal says
  // nothing about codes, so it is no oracle for the password. The hit is given back below unless the
  // attempt turns out to be a wrong code after a correct password.
  const step = totpCode !== undefined ? { ...form, totpStep: "1" } : form;
  const codeWho = { ip: guard.ip, email };
  let reservedAt: Date | null = null;
  if (totpCode !== undefined) {
    reservedAt = ctx.clock.now();
    const reserved = await ctx.ports.limit("signin_code", codeWho, guard.key);
    if (!reserved.allowed) {
      return failure(ctx, "rate_limited", {
        form: step,
        retryAfterSeconds: reserved.retryAfterSeconds,
      });
    }
  }

  // 5. Execute.
  // The code step stays on the form after a failure of a sign-in that carried a code (a flag, never the code).
  const answer = await guard.identity.signIn({
    email,
    password,
    ...(totpCode !== undefined ? { totpCode } : {}),
  });
  // Only a wrong code after a correct password keeps its reservation; every other outcome gives it back
  // (a right code, a wrong password, the provider unavailable or limiting, another challenge). If the
  // release cannot be made the hit stays counted: the safe direction.
  if (reservedAt !== null && !(!answer.ok && answer.kind === "code_denied")) {
    const given = await ctx.ports.limitRelease("signin_code", codeWho, guard.key, reservedAt);
    if (!given) logAuth(ctx, "auth.signin", "code_limit_release_failed");
  }
  if (!answer.ok) {
    logAuth(ctx, "auth.signin", answer.kind);
    switch (answer.kind) {
      case "rate_limited":
        return failure(ctx, "rate_limited", { form: step, retryAfterSeconds: 60 });
      case "unavailable":
        return failure(ctx, "unavailable", { form: step });
      case "code_denied": {
        // The password was right and the code was not: its reservation stays counted. When that filled
        // the limit the customer is told by email and the screen says to wait; until then the screen
        // stays the generic answer.
        const blocked = await noticeIfBlocked(ctx, guard, email);
        if (blocked !== null) {
          return failure(ctx, "rate_limited", { form: step, retryAfterSeconds: blocked });
        }
        return failure(ctx, "sign_in_failed", { form: step });
      }
      default:
        // A wrong password and a wrong, reused or expired code are one answer (no enumeration).
        return failure(ctx, "sign_in_failed", { form: step });
    }
  }
  if (answer.value.kind === "challenge") {
    logAuth(ctx, "auth.signin", "challenge");
    // WPU-X11: the password was right and the authenticator is on: ask for the code. The provider
    // answers a code only with the password again (the Cognito Session never leaves the adapter).
    if (answer.value.challenge === "totp" && totpCode === undefined) {
      return failure(ctx, "totp_required", { form: { ...form, totpStep: "1" } });
    }
    // Another challenge (a new password, MFA setup, ...) has no screen here: refuse closed (R16).
    return failure(ctx, "unavailable", { form });
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
      // WPU-X11 round 2: whether these tokens answered the authenticator challenge of this flow.
      ...(answer.value.totpVerified === true ? { totpVerified: true as const } : {}),
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
/**
 * WPU-X11 round 2. One authenticator code failed after a correct password, and its reservation stays
 * counted. When that filled the limit (5 in 15 minutes or 20 a day), queue the email to the address that
 * typed the password and return the seconds to wait; otherwise null. The notice never changes what the
 * screen says beyond that wait, and a notice that cannot be queued is dropped (the sign-in is refused
 * either way). The email has a dedupe key per address and quarter hour, so parallel failures send one.
 */
async function noticeIfBlocked(
  ctx: ActionContext,
  guard: { ip: string; key: string },
  email: string,
): Promise<number | null> {
  const full = await ctx.ports.limitPeek("signin_code", { ip: guard.ip, email }, guard.key);
  if (full.allowed) return null;
  logAuth(ctx, "auth.signin", "code_limit");
  try {
    await ctx.ports.noticeTotpBlocked({ email, ip: guard.ip, key: guard.key });
  } catch {
    logAuth(ctx, "auth.signin", "notice_failed");
  }
  return full.retryAfterSeconds;
}
