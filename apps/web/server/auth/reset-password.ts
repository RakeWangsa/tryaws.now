import { parseResetForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth } from "./common.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * The new password with the emailed code. A wrong code, an expired code and an unknown address are
 * one `code_wrong`; a password the pool refuses is `password_rejected` on the password field. The
 * password is never echoed.
 */
export async function resetPasswordCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  const parsed = parseResetForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const { email, code, password } = parsed.value;

  const limit = await ctx.ports.limit("reset", { ip: guard.ip, email }, guard.key);
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  const answer = await guard.identity.confirmForgotPassword({
    email,
    code,
    newPassword: password,
  });
  if (!answer.ok) {
    logAuth(ctx, "auth.reset", answer.kind);
    switch (answer.kind) {
      case "invalid_password":
        return failure(ctx, "password_rejected", { fields: { password: "invalid" }, form });
      case "rate_limited":
        return failure(ctx, "rate_limited", { form, retryAfterSeconds: 60 });
      case "unavailable":
        return failure(ctx, "unavailable", { form });
      default:
        return failure(ctx, "code_wrong", { form });
    }
  }

  logAuth(ctx, "auth.reset", "ok");
  return done(`${localePath(localeOf(form), "/login")}?reset=1`, { pending: "clear" });
}
