import { lookupCustomerBySub, withTx } from "@tc/db";
import type { AuthConfig } from "./config";
import { cognitoRefreshPort, needsRefresh, refreshSession } from "./refresh";
import type { RefreshOutcome, RefreshPort } from "./refresh";
import { parseCookieHeader } from "./cookies";
import { authenticateCustomer } from "./session";
import type { SessionDeps, SessionOutcome } from "./session";
import type { SignInDeps } from "./sign-in";
import { createAccessTokenVerifier } from "./tokens";
import type { Clock } from "./types";

// The shape configureAuth accepts, so an app builds the runtime once and uses it for both. Tests
// inject verifier, lookup and port; production leaves them out.
export interface AuthRuntimeLike {
  readonly config: AuthConfig;
  readonly clock?: Clock;
  readonly verifier?: SessionDeps["verifier"];
  readonly lookup?: SessionDeps["lookup"];
  readonly port?: RefreshPort;
  readonly onDenied?: SessionDeps["onDenied"];
}

interface Built {
  readonly session: SessionDeps;
  readonly clock: Clock;
  readonly port: RefreshPort;
}

// The verifier holds the JWKS cache, so a default one is built once per runtime object, not per request.
const built = new WeakMap<AuthRuntimeLike, Built>();

function build(runtime: AuthRuntimeLike): Built {
  const known = built.get(runtime);
  if (known) return known;
  const verifier = runtime.verifier ?? createAccessTokenVerifier(runtime.config.customer);
  const lookup = runtime.lookup ?? ((sub: string) => withTx((tx) => lookupCustomerBySub(tx, sub)));
  const onDenied = runtime.onDenied;
  const made: Built = {
    session: { verifier, lookup, ...(onDenied ? { onDenied } : {}) },
    clock: runtime.clock ?? { now: () => new Date() },
    port: runtime.port ?? cognitoRefreshPort(runtime.config.customer),
  };
  built.set(runtime, made);
  return made;
}

// The dependencies completeSignIn needs, from the same runtime object that authenticateRequest and
// refreshForProxy use, so an app that cannot name the lookup (only this package turns a sub into a
// customer id, R8) can finish a sign-in. The customer pool's verifier and the cookie lifetime come
// from the runtime config; nothing here reads the environment.
export function signInDepsFor(runtime: AuthRuntimeLike): SignInDeps {
  const { session, clock } = build(runtime);
  return {
    ...session,
    clock,
    refreshMaxAgeSeconds: runtime.config.refreshCookieMaxAgeSeconds,
  };
}

// Only the Cookie header is read. Authorization, X-Customer-Id and Origin are never looked at, so a
// request cannot name its customer (R8).
function cookieHeaderOf(request: { headers: Headers }): string | null {
  return request.headers.get("cookie");
}

// Never throws (R16): a runtime that cannot be built or a request that cannot be read is no session.
export async function authenticateRequest(
  runtime: AuthRuntimeLike,
  request: { headers: Headers },
): Promise<SessionOutcome> {
  try {
    return await authenticateCustomer(build(runtime).session, cookieHeaderOf(request));
  } catch {
    return { ok: false, error: "upstream_unavailable", reason: "unavailable" };
  }
}

// For proxy.ts. refreshSession does not decide whether a refresh is due, so needsRefresh is asked
// first. Anything that goes wrong keeps the cookies as they are ("none"); the next verification
// decides what the request may do.
export async function refreshForProxy(
  runtime: AuthRuntimeLike,
  request: { headers: Headers },
): Promise<RefreshOutcome> {
  try {
    const { clock, port, session } = build(runtime);
    const header = cookieHeaderOf(request);
    if (!needsRefresh(parseCookieHeader(header), clock, runtime.config.refreshWindowSeconds)) {
      return { action: "none" };
    }
    return await refreshSession(
      { port, verifier: session.verifier, clock, config: runtime.config },
      header,
    );
  } catch {
    return { action: "none" };
  }
}
