import { clearCookieSpecs } from "@tc/auth";
import type { CookieSpec } from "@tc/auth";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { actionContext } from "./auth/context.ts";
import type { ActionContext } from "./auth/context.ts";
import { clearPendingCookieSpec, pendingCookieSpec } from "./auth/pending.ts";
import type { PendingCookieSpec } from "./auth/pending.ts";
import type { Effects, FormState, Outcome } from "./auth/state.ts";
import { requestId } from "./request.ts";
import { getRuntime } from "./runtime.ts";
import type { WebRuntime } from "./runtime.ts";

// The thin layer between a Server Action and a core (Task 9). Cores are plain functions of a context
// and a form; this file owns what needs the Next runtime: the request headers, the cookie jar and
// redirect(). Cookies are set only from the specs that @tc/auth builds from its own names and checks
// (and the pending-cookie spec of server/auth/pending.ts); no code path builds a cookie string.
//
// Adaptation to the plan: the plan puts this file in server/auth/, but the boundary test of the cores
// (tests/repo/auth-actions.test.mjs) keeps next/* out of that folder, so it lives next to it.

export interface CookieJar {
  set(options: {
    name: string;
    value: string;
    maxAge: number;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "lax";
  }): unknown;
}

export interface WrapDeps {
  runtime: () => Promise<WebRuntime>;
  headers: () => Promise<Headers>;
  jar: () => Promise<CookieJar>;
  redirect: (to: string) => never;
  context?: (headers: Headers, runtime: WebRuntime) => ActionContext;
}

const specOf = (spec: CookieSpec | PendingCookieSpec) => ({
  name: spec.name,
  value: spec.value,
  maxAge: spec.maxAge,
  path: spec.path,
  httpOnly: spec.httpOnly,
  secure: spec.secure,
  sameSite: spec.sameSite,
});

async function apply(jar: CookieJar, effects: Effects): Promise<void> {
  for (const spec of effects.setCookies) jar.set(specOf(spec));
  for (const spec of effects.clearCookies) jar.set(specOf(spec));
  if (effects.pending === "clear") jar.set(specOf(clearPendingCookieSpec()));
  else if (effects.pending !== null) jar.set(specOf(pendingCookieSpec(effects.pending)));
}

/** A runner over the given dependencies. `runAction` below is the one the app uses. */
export function makeRunner(deps: WrapDeps) {
  return async function run(core: (ctx: ActionContext) => Promise<Outcome>): Promise<FormState> {
    let target: string | null = null;
    let state: FormState;
    try {
      const [h, runtime] = await Promise.all([deps.headers(), deps.runtime()]);
      const ctx = (deps.context ?? actionContext)(h, runtime);
      const outcome = await core(ctx);
      await apply(await deps.jar(), outcome.effects);
      state = outcome.state;
      if (outcome.state.status === "done") target = outcome.state.redirectTo;
    } catch {
      // Every throw is the same generic state: no text of the error, no cookie (R14, R16).
      return { status: "error", code: "unavailable", ref: requestId() };
    }
    // redirect() works by throwing; it must stay outside the try block.
    if (target !== null) deps.redirect(target);
    return state;
  };
}

/** Runs a core in a Server Action: headers and runtime from Next, cookies through cookies(), redirect on "done". */
export const runAction = makeRunner({
  runtime: getRuntime,
  headers: async () => new Headers(await headers()),
  jar: async () => (await cookies()) as unknown as CookieJar,
  redirect,
});

/**
 * WPU-X11 round 2: clears the two session cookies from a Server Action that ended every session of the
 * customer (the authenticator was switched on or off). The cookies come only from the specs of @tc/auth.
 */
export async function clearSessionCookies(): Promise<void> {
  const jar = (await cookies()) as unknown as CookieJar;
  await apply(jar, { setCookies: [], clearCookies: clearCookieSpecs(), pending: null });
}

/** The form of a posted FormData: text and files by name, the last value of a repeated name. */
export function formOf(data: FormData): Record<string, unknown> {
  return Object.fromEntries(data.entries());
}
