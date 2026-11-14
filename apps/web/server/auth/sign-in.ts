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

  // WPU-X11 round 2: with a code, first ask whether this address has already used up its wrong codes
  // (5 in 15 minutes, 20 a day, counted only after a correct password). The provider is not asked then.
  // The refusal says nothing about codes, so it is no oracle for the password.
  const step = totpCode !== undefined ? { ...form, totpStep: "1" } : form;
  if (totpCode !== undefined) {
    const used = await ctx.ports.limitPeek("signin_code", { ip: guard.ip, email }, guard.key);
    if (!used.allowed) {
      return failure(ctx, "rate_limited", {
        form: step,
        retryAfterSeconds: used.retryAfterSeconds,
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
  if (!answer.ok) {
    logAuth(ctx, "auth.signin", answer.kind);
    switch (answer.kind) {
      case "rate_limited":
        return failure(ctx, "rate_limited", { form: step, retryAfterSeconds: 60 });
      case "unavailable":
        return failure(ctx, "unavailable", { form: step });
      case "code_denied": {
        // The password was right and the code was not. Count it against the wrong-code limit; the fifth
        // fills it and the customer is told by email. The screen stays the generic answer until then.
        const blocked = await countWrongCode(ctx, guard, email);
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
 * WPU-X11 round 2. One authenticator code failed after a correct password: count it. When that fills the
 * limit (5 in 15 minutes or 20 a day), queue the email to the address that typed the password and return
 * the seconds to wait; otherwise null. The count and the notice never change what the screen says beyond
 * that wait, and a notice that cannot be queued is dropped (the sign-in is refused either way).
 */
async function countWrongCode(
  ctx: ActionContext,
  guard: { ip: string; key: string },
  email: string,
): Promise<number | null> {
  const who = { ip: guard.ip, email };
  await ctx.ports.limit("signin_code", who, guard.key);
  const now = await ctx.ports.limitPeek("signin_code", who, guard.key);
  if (now.allowed) return null;
  logAuth(ctx, "auth.signin", "code_limit");
  try {
    await ctx.ports.noticeTotpBlocked({ email, ip: guard.ip, key: guard.key });
  } catch {
    logAuth(ctx, "auth.signin", "notice_failed");
  }
  return now.retryAfterSeconds;
}
