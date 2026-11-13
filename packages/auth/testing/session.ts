// Test code only: for the cross-tenant (IDOR) tests of the endpoints (R8). The endpoint test calls
// the action as customer A with withRequireCustomerAs(sessionFor(A)) and tries to reach B's row.
import type { AdminRole, CustomerIdentity } from "@tc/db";
import { configureAdminAuth, resetAdminAuthForTests } from "../admin";
import type { AuthConfig } from "../config";
import { ACCESS_COOKIE, ADMIN_ACCESS_COOKIE } from "../cookies";
import { configureAuth, resetAuthForTests } from "../require";
import type { AccessTokenVerifier } from "../tokens";
import type { CustomerSession } from "../types";

export function sessionFor(
  customerId: string,
  overrides: Partial<CustomerSession> = {},
): CustomerSession {
  return {
    customerId,
    kycStatus: "verified",
    riskTier: "new",
    locale: "bn",
    signedInAt: new Date(),
    ...overrides,
  };
}

// Identifiers only, no secret. Never used to verify anything: the verifier below is a stub.
const STUB_CONFIG: AuthConfig = {
  customer: {
    region: "ap-southeast-1",
    userPoolId: "ap-southeast-1_STUBPOOL1",
    clientId: "stubclient0123456789",
  },
  refreshWindowSeconds: 300,
  refreshCookieMaxAgeSeconds: 2_592_000,
};

// requireCustomer() yields exactly this session. Returns the undo.
export function withRequireCustomerAs(session: CustomerSession): () => void {
  const sub = `stub-sub-${session.customerId}`;
  const verifier: AccessTokenVerifier = {
    verify: () =>
      Promise.resolve({
        ok: true,
        token: {
          sub,
          issuedAt: new Date(),
          authTime: session.signedInAt,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
  };
  const identity: CustomerIdentity = {
    id: session.customerId,
    status: "active",
    sessionsValidAfter: null,
    kycStatus: session.kycStatus,
    riskTier: session.riskTier,
    locale: session.locale,
  };
  configureAuth({
    config: STUB_CONFIG,
    readCookieHeader: () => Promise.resolve(`${ACCESS_COOKIE}=stub`),
    deps: { verifier, lookup: () => Promise.resolve(identity) },
  });
  return resetAuthForTests;
}

// requireAdmin() yields exactly this actor, for the endpoint tests of the admin app (R10). The
// verifier, the lookup and the allowlist are stubs: a role outside the list the action names is
// still refused by the real guard, so a test of the role check keeps working.
export function withRequireAdminAs(actor: {
  adminId: string;
  role: AdminRole;
  ip?: string;
  userAgent?: string;
}): () => void {
  const ip = actor.ip ?? "203.0.113.10";
  const verifier: AccessTokenVerifier = {
    verify: () =>
      Promise.resolve({
        ok: true,
        token: {
          sub: `stub-admin-${actor.adminId}`,
          issuedAt: new Date(),
          authTime: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
  };
  configureAdminAuth({
    config: {
      admin: {
        region: "ap-southeast-1",
        userPoolId: "ap-southeast-1_STUBADMIN1",
        clientId: "stubadminclient012345",
      },
      allowlist: [ip],
    },
    readRequest: () =>
      Promise.resolve({
        cookieHeader: `${ADMIN_ACCESS_COOKIE}=stub`,
        viewerAddress: `${ip}:443`,
        userAgent: actor.userAgent ?? null,
      }),
    deps: {
      verifier,
      lookup: () => Promise.resolve({ id: actor.adminId, role: actor.role, status: "active" }),
    },
  });
  return resetAdminAuthForTests;
}
