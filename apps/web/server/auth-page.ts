import { currentCustomer } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import type { Locale } from "@tc/ui/runtime";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { landingPath } from "./auth/landing.ts";
import { PENDING_COOKIE, decodePending } from "./auth/pending.ts";
import type { Pending } from "./auth/pending.ts";
import { getRuntime } from "./runtime.ts";
import type { WebRuntime } from "./runtime.ts";

// What the five server-rendered auth pages share. Reading the session, the runtime and the pending
// cookie needs the Next runtime, so it lives here and not in the cores.

export interface AuthPageData {
  runtime: WebRuntime;
  /** false = the identity provider or the limiter key is missing: the page shows "not available" (R16). */
  available: boolean;
  session: CustomerSession | null;
}

/**
 * Loads the runtime and the session. A page for guests (`guest: true`) sends a signed-in customer to
 * the panel: to `next` when it passes the allow-list (U12), else to the default landing.
 */
export async function loadAuthPage(
  locale: Locale,
  next: unknown,
  opts: { guest: boolean },
): Promise<AuthPageData> {
  const runtime = await getRuntime();
  const found = await currentCustomer();
  const session = found.ok ? found.value : null;
  if (opts.guest && session !== null) redirect(landingPath(locale, next));
  return {
    runtime,
    available: runtime.identity !== null && runtime.authLimitKey !== null,
    session,
  };
}

/** The prefill cookie, strictly parsed; a forged or old one is null (open point 5). */
export async function readPending(): Promise<Pending | null> {
  return decodePending((await cookies()).get(PENDING_COOKIE)?.value);
}

/** The first text value of a query parameter. */
export function queryText(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

/** A banner flag is exactly "1": any other value shows nothing and never chooses a target. */
export function isFlag(value: string | string[] | undefined): boolean {
  return queryText(value) === "1";
}
