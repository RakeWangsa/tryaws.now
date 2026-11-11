import { parseEmailForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth, pendingFor } from "./common.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * "Send the code again." An address that has no account, or one that is confirmed already, gets the
 * same answer as one that has (the adapter folds those): the page reloads with a fresh timer.
 */
export async function resendEmailCodeCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  const parsed = parseEmailForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const { email } = parsed.value;

  const limit = await ctx.ports.limit("resend", { ip: guard.ip, email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  const answer = await guard.identity.resendConfirmationCode(email);
  if (!answer.ok) {
    logAuth(ctx, "auth.resend", answer.kind);
    if (answer.kind === "rate_limited") {
      return failure(ctx, "rate_limited", { form, retryAfterSeconds: 60 });
    }
    return failure(ctx, "unavailable", { form });
  }

  logAuth(ctx, "auth.resend", "ok");
  return done(localePath(localeOf(form), "/verify"), {
    pending: pendingFor(ctx, "signup", email),
  });
}
