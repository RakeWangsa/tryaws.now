import { lookupAdminBySub, withTx } from "@tc/db";
import type { AdminActor, AdminIdentity, AdminRole } from "@tc/db";
import { ipAllowed, parseViewerAddress } from "./admin-ip";
import { ADMIN_SESSION_SECONDS, type AdminAuthConfig } from "./config";
import { ADMIN_ACCESS_COOKIE, parseCookieHeader } from "./cookies";
import type { AccessTokenVerifier } from "./tokens";
import { createAccessTokenVerifier } from "./tokens";
import { AuthError, toResult } from "./types";
import type { AuthReason, Clock, Denied, Result } from "./types";

// 6.1, 6.2, R10: the admin session, one request. Order: the IP allowlist, the admin cookie, the token
// of the ADMIN pool, the admin row, its status, the second factor in the token, the role. A failure
// stops the rest; it never throws and never returns an actor unless every step passed (R16).

export interface AdminRequestInfo {
  // The Cookie header and the CloudFront-Viewer-Address header; nothing else of the request is read.
  readonly cookieHeader: string | null | undefined;
  readonly viewerAddress: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export interface AdminSessionDeps {
  readonly verifier: AccessTokenVerifier; // of the admin pool
  readonly lookup: (sub: string) => Promise<AdminIdentity | null>;
  readonly allowlist: readonly string[];
  readonly clock?: Clock;
  readonly onDenied?: (reason: AuthReason) => void;
}

export type AdminOutcome = { readonly ok: true; readonly actor: AdminActor } | Denied;

// The one place that says what "TOTP was used" means: the token's `amr` list holds "mfa".
// VERIFY on staging: whether the Cognito access token carries `amr`; if it does not, a pre token
// generation trigger of the admin pool adds it, and only this constant changes.
export const MFA_METHOD = "mfa";

const MAX_USER_AGENT = 200;

export async function authenticateAdmin(
  deps: AdminSessionDeps,
  request: AdminRequestInfo,
  roles: readonly AdminRole[],
): Promise<AdminOutcome> {
  const deny = (error: Denied["error"], reason: AuthReason): Denied => {
    try {
      deps.onDenied?.(reason);
    } catch {
      // The hook is for counting; its failure must not turn a refusal into anything else.
    }
    return { ok: false, error, reason };
  };

  try {
    // 1. The address, before anything else is read: outside the allowlist nothing is looked at.
    const ip = parseViewerAddress(request.viewerAddress);
    if (ip === null || !ipAllowed(ip, deps.allowlist)) return deny("forbidden", "ip_not_allowed");

    // 2. The admin cookie. A customer cookie is not one.
    const accessToken = parseCookieHeader(request.cookieHeader).get(ADMIN_ACCESS_COOKIE);
    if (accessToken === undefined || accessToken.length === 0) {
      return deny("unauthenticated", "no_cookie");
    }

    // 3. Signature, issuer and client of the admin pool, token_use, expiry.
    const verified = await deps.verifier.verify(accessToken);
    if (!verified.ok) return deny(verified.error, verified.reason);
    const { token } = verified;

    // 4. Short sessions: 8 hours from the sign-in, whatever the token's own expiry says.
    const now = (deps.clock ?? { now: () => new Date() }).now().getTime();
    const age = now - token.authTime.getTime();
    if (!(age <= ADMIN_SESSION_SECONDS * 1000)) return deny("unauthenticated", "token_expired");

    // 5. The admin of that sub, and only an active one (6.1).
    let admin: AdminIdentity | null;
    try {
      admin = await deps.lookup(token.sub);
    } catch {
      return deny("upstream_unavailable", "unavailable");
    }
    if (admin === null || admin === undefined) return deny("unauthenticated", "unknown_subject");
    if (admin.status !== "active") return deny("forbidden", "disabled");

    // 6. TOTP is required, always: the token must say that the second factor was used.
    if (!token.amr.includes(MFA_METHOD)) return deny("forbidden", "mfa_required");

    // 7. The role guard (R9: authorize). An empty list allows nobody.
    if (!roles.includes(admin.role)) return deny("forbidden", "role_not_allowed");

    const userAgent =
      typeof request.userAgent === "string" && request.userAgent !== ""
        ? request.userAgent.slice(0, MAX_USER_AGENT)
        : undefined;
    return {
      ok: true,
      actor: {
        adminId: admin.id,
        role: admin.role,
        ip,
        ...(userAgent !== undefined ? { userAgent } : {}),
      },
    };
  } catch {
    return deny("upstream_unavailable", "unavailable");
  }
}

export interface AdminAuthRuntime {
  readonly config: AdminAuthConfig;
  // Next: read headers() into this shape; tests: a constant.
  readonly readRequest: () => Promise<AdminRequestInfo>;
  readonly deps?: Partial<Pick<AdminSessionDeps, "verifier" | "lookup" | "onDenied">>;
  readonly clock?: Clock;
}

interface Configured {
  readonly readRequest: AdminAuthRuntime["readRequest"];
  readonly deps: AdminSessionDeps;
}

// Module state apart from configureAuth: the customer session and the admin session never share one.
let configured: Configured | null = null;

export function configureAdminAuth(runtime: AdminAuthRuntime): void {
  const verifier = runtime.deps?.verifier ?? createAccessTokenVerifier(runtime.config.admin);
  const lookup =
    runtime.deps?.lookup ?? ((sub: string) => withTx((tx) => lookupAdminBySub(tx, sub)));
  const onDenied = runtime.deps?.onDenied;
  configured = {
    readRequest: runtime.readRequest,
    deps: {
      verifier,
      lookup,
      allowlist: runtime.config.allowlist,
      ...(runtime.clock ? { clock: runtime.clock } : {}),
      ...(onDenied ? { onDenied } : {}),
    },
  };
}

// For testing/ only; not exported from the barrel.
export function resetAdminAuthForTests(): void {
  configured = null;
}

// F. Step one and two of every admin action (R9): the roles say who may act. Rejects with AuthError;
// the text is fixed and holds no token (R14).
export async function requireAdmin(roles: AdminRole[]): Promise<AdminActor> {
  const current = configured;
  if (current === null) throw new AuthError("unauthenticated", "not_configured");

  let request: AdminRequestInfo;
  try {
    request = await current.readRequest();
  } catch {
    throw new AuthError("unauthenticated", "no_cookie");
  }

  const outcome = await authenticateAdmin(current.deps, request, roles);
  if (!outcome.ok) throw new AuthError(outcome.error, outcome.reason);
  return outcome.actor;
}

// The same as a Result, for pages that redirect. Never throws.
export async function currentAdmin(roles: AdminRole[]): Promise<Result<AdminActor>> {
  try {
    return { ok: true, value: await requireAdmin(roles) };
  } catch (error) {
    return toResult(error);
  }
}
