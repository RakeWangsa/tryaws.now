import { clearCookieSpecs } from "@tc/auth";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { ActionContext } from "./context.ts";
import { done, failure, logAuth, userAgentOf } from "./common.ts";
import { assertSameOrigin } from "../request.ts";
import type { Outcome } from "./state.ts";

/**
 * Sign out of this device (open point 17): best-effort revocation of the refresh token at the
 * provider, both cookies cleared whatever it answers, an audit row. Signing out everywhere is WP2-T5.
 */
export async function signOutCore(
  ctx: ActionContext,
  refreshToken: string | undefined,
  locale: Locale = "bn",
): Promise<Outcome> {
  // 1. Authenticate.
  const found = await ctx.ports.requireSession();

  // 2. Authorize: our own origin.
  if (!assertSameOrigin(ctx.headers, ctx.runtime.config)) return failure(ctx, "bad_origin");

  const target = localePath(found.ok ? found.session.locale : locale, "/login");
  const cleared = { clearCookies: clearCookieSpecs() };
  if (!found.ok) {
    // Nobody is signed in (or the session cannot be read): clear what is there and go to sign-in.
    return done(target, cleared);
  }

  // 3. and 4. There is no input and the action cannot be abused for volume: no parser, no limiter.
  // 5. Execute: revoke the refresh token if the provider is configured; its answer changes nothing.
  if (refreshToken !== undefined && refreshToken !== "" && ctx.runtime.identity !== null) {
    await ctx.runtime.identity.revokeRefreshToken(refreshToken).catch(() => undefined);
  }

  // 6. Audit. A failure does not keep the customer signed in.
  try {
    const userAgent = userAgentOf(ctx);
    await ctx.ports.recordSignOut(found.session, {
      ...(ctx.ip !== null ? { ip: ctx.ip } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
    });
  } catch {
    logAuth(ctx, "auth.signout", "audit_failed");
  }
  logAuth(ctx, "auth.signout", "ok");
  return done(target, cleared);
}
