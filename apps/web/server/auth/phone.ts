import { parsePhoneCodeForm, parsePhoneForm } from "@tc/core";
import { localePath } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, localeOf, logAuth } from "./common.ts";
import { landingPath } from "./landing.ts";
import { assertSameOrigin } from "../request.ts";
import type { Outcome } from "./state.ts";

type Form = Readonly<Record<string, unknown>>;

// The shape the OTP service accepts for an idempotency key (policy.ts OTP_IDEMPOTENCY_KEY, which the
// package does not export). A key that does not match is replaced by the page, never sent.
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

// The seconds a customer waits after five wrong codes: a new code is the way on.
const ATTEMPTS_USED_RETRY_SECONDS = 300;

/**
 * The phone step of /verify. The customer id comes only from the session (R8); a customerId field in
 * the form is ignored because nothing reads it.
 */
export async function sendPhoneCodeCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  // 1. Authenticate.
  const found = await ctx.ports.requireSession();
  const locale = localeOf(form);
  if (!found.ok) {
    return found.reason === "unavailable"
      ? failure(ctx, "unavailable", { form })
      : done(localePath(locale, "/login"));
  }

  // 2. Authorize: origin, viewer address, a configured OTP service.
  if (!assertSameOrigin(ctx.headers, ctx.runtime.config)) return failure(ctx, "bad_origin");
  if (ctx.ip === null) return failure(ctx, "unavailable", { form });
  if (ctx.runtime.otp === null) return failure(ctx, "not_open", { form });

  // 3. Validate.
  const parsed = parsePhoneForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });
  const key = form["idempotencyKey"];
  if (typeof key !== "string" || !KEY_SHAPE.test(key)) {
    // A missing or bad key: nothing is sent; the page renders again with a fresh key.
    return done(localePath(locale, "/verify"));
  }

  // 4. and 5. The service limits by number and by address and sends once per key.
  const sent = await ctx.ports.sendOtp(found.session, {
    phone: parsed.value.phone,
    ip: ctx.ip,
    idempotencyKey: key,
  });
  if (!sent.ok) {
    logAuth(ctx, "otp.send", sent.error);
    switch (sent.error) {
      case "rate_limited": {
        const data = sent.data as { retryAfterSeconds?: unknown } | undefined;
        const seconds = typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : 60;
        return failure(ctx, "rate_limited", { form, retryAfterSeconds: seconds });
      }
      case "validation":
        return failure(ctx, "invalid", { fields: { phone: "invalid" }, form });
      case "conflict":
        return done(localePath(locale, "/verify"));
      default:
        return failure(ctx, "unavailable", { form });
    }
  }

  // 6. The OTP service wrote the challenge in its own transaction; the page reads it.
  logAuth(ctx, "otp.send", sent.value.replayed ? "replayed" : "sent");
  return done(localePath(locale, "/verify"));
}

export async function verifyPhoneCodeCore(ctx: ActionContext, form: Form): Promise<Outcome> {
  const found = await ctx.ports.requireSession();
  const locale = localeOf(form);
  if (!found.ok) {
    return found.reason === "unavailable"
      ? failure(ctx, "unavailable", { form })
      : done(localePath(locale, "/login"));
  }

  if (!assertSameOrigin(ctx.headers, ctx.runtime.config)) return failure(ctx, "bad_origin");
  if (ctx.runtime.otp === null) return failure(ctx, "not_open", { form });

  const parsed = parsePhoneCodeForm(form);
  if (!parsed.ok) return failure(ctx, "invalid", { fields: parsed.fields, form });

  // The service counts the attempt before it compares (five per challenge).
  const verified = await ctx.ports.verifyOtp(found.session, { code: parsed.value.code });
  if (!verified.ok) {
    logAuth(ctx, "otp.verify", verified.error);
    switch (verified.error) {
      case "limit_reached":
        return failure(ctx, "rate_limited", {
          form,
          retryAfterSeconds: ATTEMPTS_USED_RETRY_SECONDS,
        });
      case "upstream_unavailable":
        return failure(ctx, "unavailable", { form });
      default:
        return failure(ctx, "code_wrong", { form });
    }
  }

  logAuth(ctx, "otp.verify", "ok");
  return done(landingPath(locale, form["next"]));
}
