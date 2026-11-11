import { parseSignUpForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth, pendingFor, userAgentOf } from "./common.ts";
import { landingPath } from "./landing.ts";
import { LEGAL_VERSIONS } from "./legal.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * Sign-up, in the R9 order. A new address and an existing one give the same outcome (the same
 * redirect and the same pending cookie); the one difference is a resend of the code for an existing
 * address, whose answer is ignored (open point 7, the stated timing residual).
 */
export async function signUpCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  // 1. Authenticate: public by design; a customer who is signed in already goes to the panel.
  const current = await ctx.ports.currentSession();
  if (current !== null) return done(landingPath(localeOf(form), form["next"]));

  // 2. Authorize.
  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  // 3. Validate with the shared parser. A password is never echoed.
  const parsed = parseSignUpForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const input = parsed.value;

  // 4. Rate limit.
  const limit = await ctx.ports.limit("signup", { ip: guard.ip, email: input.email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  // 5. Execute: Cognito user first, then the customer, wallet, acceptances and audit row in one
  // transaction (registerAccount; the audit row is part of it).
  const userAgent = userAgentOf(ctx);
  const registered = await ctx.ports.register({
    email: input.email,
    phone: input.phone,
    name: input.fullName,
    locale: input.locale,
    password: input.password,
    acceptances: [
      { document: "terms", version: LEGAL_VERSIONS.terms },
      { document: "acceptable_use", version: LEGAL_VERSIONS.acceptable_use },
      { document: "privacy", version: LEGAL_VERSIONS.privacy },
    ],
    ip: guard.ip,
    ...(userAgent !== undefined ? { userAgent } : {}),
  });

  if (!registered.ok) {
    switch (registered.error) {
      case "validation":
        return failure(ctx, "password_rejected", { fields: { password: "invalid" }, form });
      case "market_unavailable":
        return failure(ctx, "not_open", { form });
      case "rate_limited":
        return failure(ctx, "rate_limited", { form, retryAfterSeconds: 60 });
      case "internal":
        // The orphan case (open point 11): the user exists at the provider, the row was not written.
        logAuth(ctx, "signup.orphan_risk", "internal");
        return failure(ctx, "unavailable", { form });
      default:
        return failure(ctx, "unavailable", { form });
    }
  }

  if (registered.status === "exists") {
    // Same page, same cookie. The resend only helps an unconfirmed owner; its answer is ignored.
    await guard.identity.resendConfirmationCode(input.email).catch(() => undefined);
  }

  // 6. Audit: the customer row, the acceptances and the `customer.register` audit row were written
  // by the registration transaction; the log line has an event, an outcome and a reference only.
  logAuth(ctx, "auth.signup", registered.status);
  return done(localePath(localeOf(form), "/verify"), {
    pending: pendingFor(ctx, "signup", input.email),
  });
}
