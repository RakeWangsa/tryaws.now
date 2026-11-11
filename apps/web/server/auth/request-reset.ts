import { parseEmailForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth, pendingFor } from "./common.ts";
import { landingPath } from "./landing.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * "Forgot password." Every address, known or not, ends on /reset-password with the same pending
 * cookie. Only our own limiter and an unreachable provider are shown; every other answer of the
 * provider is folded into "done" (open point 7).
 */
export async function requestResetCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  const current = await ctx.ports.currentSession();
  if (current !== null) return done(landingPath(localeOf(form), form["next"]));

  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  const parsed = parseEmailForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const { email } = parsed.value;

  const limit = await ctx.ports.limit("forgot", { ip: guard.ip, email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  const answer = await guard.identity.forgotPassword(email);
  if (!answer.ok) {
    logAuth(ctx, "auth.forgot", answer.kind);
    if (answer.kind === "unavailable") return failure(ctx, "unavailable", { form });
  } else {
    logAuth(ctx, "auth.forgot", "ok");
  }

  return done(localePath(localeOf(form), "/reset-password"), {
    pending: pendingFor(ctx, "reset", email),
  });
}
