import { lookupCustomerBySub, withTx } from "@tc/db";
import type { AuthConfig } from "./config";
import { authenticateCustomer, type SessionDeps } from "./session";
import { createAccessTokenVerifier } from "./tokens";
import { AuthError, toResult } from "./types";
import type { Clock, CustomerSession, Result } from "./types";

export interface AuthRuntime {
  readonly config: AuthConfig;
  // Next: serialize (await cookies()).getAll(); tests: a constant.
  readonly readCookieHeader: () => Promise<string | null | undefined>;
  // Tests inject these; production leaves it.
  readonly deps?: Partial<Pick<SessionDeps, "verifier" | "lookup" | "onDenied">>;
  readonly clock?: Clock;
}

interface Configured {
  readonly readCookieHeader: AuthRuntime["readCookieHeader"];
  readonly deps: SessionDeps;
}

// Module state, set once by the app at start-up (open point 9). Calling configureAuth again replaces it.
let configured: Configured | null = null;

export function configureAuth(runtime: AuthRuntime): void {
  const verifier = runtime.deps?.verifier ?? createAccessTokenVerifier(runtime.config.customer);
  const lookup =
    runtime.deps?.lookup ?? ((sub: string) => withTx((tx) => lookupCustomerBySub(tx, sub)));
  const onDenied = runtime.deps?.onDenied;
  configured = {
    readCookieHeader: runtime.readCookieHeader,
    deps: { verifier, lookup, ...(onDenied ? { onDenied } : {}) },
  };
}

// For testing/ only; not exported from the barrel.
export function resetAuthForTests(): void {
  configured = null;
}

// F. No parameter: nothing a caller can pass changes whose session it is (R8). Step one of every
// action (R9). Rejects with AuthError; the text is fixed and holds no token (R14).
export async function requireCustomer(): Promise<CustomerSession> {
  const current = configured;
  if (current === null) throw new AuthError("unauthenticated", "not_configured");

  let header: string | null | undefined;
  try {
    header = await current.readCookieHeader();
  } catch {
    // For example cookies() outside a request: there is no request, so there is no session.
    throw new AuthError("unauthenticated", "no_cookie");
  }

  const outcome = await authenticateCustomer(current.deps, header);
  if (!outcome.ok) throw new AuthError(outcome.error, outcome.reason);
  return outcome.session;
}

// The same as a Result, for actions and pages that redirect. Never throws.
export async function currentCustomer(): Promise<Result<CustomerSession>> {
  try {
    return { ok: true, value: await requireCustomer() };
  } catch (error) {
    return toResult(error);
  }
}
