import { parseConfirmEmailForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, gate, localeOf, logAuth } from "./common.ts";
import { safeNext } from "../request.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

/**
 * The email code of a new account. A wrong code, an expired code, an unknown address and an
 * unconfirmable account are one `code_wrong` (open point 7). The address comes from the form; the
 * pending cookie only prefills it on the page.
 */
export async function confirmEmailCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  const guard = gate(ctx);
  if (!guard.ok) return guard.outcome;

  const parsed = parseConfirmEmailForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });

  const limit = await ctx.ports.limit(
    "confirm",
    { ip: guard.ip, email: parsed.value.email },
    guard.key,
  );
  if (!limit.allowed) {
    return failure(ctx, "rate_limited", { form, retryAfterSeconds: limit.retryAfterSeconds });
  }

  const answer = await guard.identity.confirmSignUp(parsed.value);
  if (!answer.ok) {
    logAuth(ctx, "auth.confirm", answer.kind);
    if (answer.kind === "rate_limited") {
      return failure(ctx, "rate_limited", { form, retryAfterSeconds: 60 });
    }
    if (answer.kind === "unavailable") return failure(ctx, "unavailable", { form });
    return failure(ctx, "code_wrong", { form });
  }

  logAuth(ctx, "auth.confirm", "ok");
  const locale = localeOf(form);
  const next = safeNext(form["next"]);
  const base = `${localePath(locale, "/login")}?verified=1`;
  return done(next === null ? base : `${base}&next=${encodeURIComponent(next)}`, {
    pending: "clear",
  });
}
