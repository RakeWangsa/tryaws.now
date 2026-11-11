import type { IdentityProvider } from "@tc/auth";
import type { FieldCode } from "@tc/core";
import type { Locale } from "@tc/ui/runtime";
import { writeLog } from "../log.ts";
import { assertSameOrigin } from "../request.ts";
import type { ActionContext } from "./context.ts";
import { encodePending } from "./pending.ts";
import { ECHOED_FIELDS } from "./state.ts";
import type { AuthErrorCode, Effects, Outcome } from "./state.ts";

// Pieces every core shares. The order of the steps in the cores is the R9 order: authenticate,
// authorize (gate), validate, rate limit, execute, audit.

export const noEffects = (): Effects => ({ setCookies: [], clearCookies: [], pending: null });

/** The locale of a form: a hidden field, because a Server Action does not see the URL's locale. */
export function localeOf(form: Readonly<Record<string, unknown>>): Locale {
  return form["locale"] === "en" ? "en" : "bn";
}

const MAX_ECHO = 320;

/** The text fields an error state may give back (never a password or a code). */
export function echo(form: Readonly<Record<string, unknown>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of ECHOED_FIELDS) {
    const value = form[name];
    if (typeof value === "string" && value.length <= MAX_ECHO) values[name] = value;
  }
  return values;
}

export function failure(
  ctx: ActionContext,
  code: AuthErrorCode,
  extra: {
    fields?: Record<string, FieldCode>;
    form?: Readonly<Record<string, unknown>>;
    retryAfterSeconds?: number;
  } = {},
): Outcome {
  return {
    state: {
      status: "error",
      code,
      ...(extra.fields !== undefined ? { fields: extra.fields } : {}),
      ...(extra.form !== undefined ? { values: echo(extra.form) } : {}),
      ...(extra.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: extra.retryAfterSeconds }
        : {}),
      ref: ctx.ref,
    },
    effects: noEffects(),
  };
}

export function done(redirectTo: string, effects: Partial<Effects> = {}): Outcome {
  return { state: { status: "done", redirectTo }, effects: { ...noEffects(), ...effects } };
}

export type Gate =
  | { ok: true; ip: string; identity: IdentityProvider; key: string }
  | { ok: false; outcome: Outcome };

/**
 * Step 2, authorize: our own origin, then a usable viewer address (the limiter and the acceptance
 * record need it), then a configured identity provider and limiter key. Each failure stops the
 * action with nothing else done (R16).
 */
export function gate(ctx: ActionContext): Gate {
  const { config, identity, authLimitKey } = ctx.runtime;
  if (!assertSameOrigin(ctx.headers, config)) {
    return { ok: false, outcome: failure(ctx, "bad_origin") };
  }
  if (ctx.ip === null) return { ok: false, outcome: failure(ctx, "unavailable") };
  if (identity === null || authLimitKey === null) {
    return { ok: false, outcome: failure(ctx, "not_open") };
  }
  return { ok: true, ip: ctx.ip, identity, key: authLimitKey };
}

/** The pending cookie value for an address, stamped with the time of this send. */
export function pendingFor(ctx: ActionContext, p: "signup" | "reset", email: string): string {
  return encodePending({ p, e: email, t: Math.floor(ctx.clock.now().getTime() / 1000) });
}

export function userAgentOf(ctx: ActionContext): string | undefined {
  const value = ctx.headers.get("user-agent");
  if (value === null || value.length === 0) return undefined;
  return value.slice(0, 256);
}

/** A structured line for events without a customer: an event name, an outcome code and a reference. */
export function logAuth(ctx: ActionContext, event: string, reason: string): void {
  writeLog({ event, reason, requestId: ctx.ref });
}
