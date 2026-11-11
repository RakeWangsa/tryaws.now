import type { AdminIdentity } from "@tc/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_ACCESS_COOKIE, ACCESS_COOKIE } from "../cookies";
import {
  authenticateAdmin,
  configureAdminAuth,
  currentAdmin,
  requireAdmin,
  resetAdminAuthForTests,
  type AdminRequestInfo,
  type AdminSessionDeps,
} from "../admin";
import { createTestIssuer, type TestIssuer } from "../testing/keys";
import { createAccessTokenVerifier } from "../tokens";
import { AuthError, type AuthReason } from "../types";

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock = { now: () => NOW };
const nowSec = Math.floor(NOW.getTime() / 1000);
const ALLOW = ["203.0.113.0/24"];
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";

let issuer: TestIssuer;
let deps: AdminSessionDeps;
const denied: AuthReason[] = [];

beforeAll(() => {
  issuer = createTestIssuer(clock);
});
afterEach(() => {
  resetAdminAuthForTests();
  denied.length = 0;
});

const admin = (over: Partial<AdminIdentity> = {}): AdminIdentity => ({
  id: ADMIN_ID,
  role: "ops",
  status: "active",
  ...over,
});

function build(found: AdminIdentity | null = admin()) {
  const lookup = vi.fn<AdminSessionDeps["lookup"]>(() => Promise.resolve(found));
  deps = {
    verifier: createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache }),
    lookup,
    allowlist: ALLOW,
    clock,
    onDenied: (r) => denied.push(r),
  };
  return lookup;
}

const mfaToken = (claims: Record<string, unknown> = {}) =>
  issuer.sign({ sub: "admin-sub-1", amr: ["pwd", "mfa"], ...claims });
const req = (token: string | null, over: Partial<AdminRequestInfo> = {}): AdminRequestInfo => ({
  cookieHeader: token === null ? null : `${ADMIN_ACCESS_COOKIE}=${token}`,
  viewerAddress: "203.0.113.5:44321",
  userAgent: "test-agent",
  ...over,
});

describe("authenticateAdmin", () => {
  it("returns the actor for a verified token with MFA, an active admin and an allowed address", async () => {
    const lookup = build();
    const out = await authenticateAdmin(deps, req(mfaToken()), ["ops", "superadmin"]);
    expect(out).toEqual({
      ok: true,
      actor: { adminId: ADMIN_ID, role: "ops", ip: "203.0.113.5", userAgent: "test-agent" },
    });
    expect(lookup).toHaveBeenCalledWith("admin-sub-1");
  });

  it("no MFA means no sign-in: a token without the mfa method is refused", async () => {
    build();
    for (const amr of [undefined, [], ["pwd"], "mfa", ["MFA"]]) {
      const out = await authenticateAdmin(deps, req(issuer.sign({ amr })), ["ops"]);
      expect(out, JSON.stringify(amr)).toEqual({
        ok: false,
        error: "forbidden",
        reason: "mfa_required",
      });
    }
  });

  it("an address outside the allowlist is refused before the cookie is read", async () => {
    const lookup = build();
    const verify = vi.spyOn(deps.verifier, "verify");
    for (const viewerAddress of ["198.51.100.1:80", null, "garbage", ""]) {
      const out = await authenticateAdmin(deps, req(mfaToken(), { viewerAddress }), ["ops"]);
      expect(out).toEqual({ ok: false, error: "forbidden", reason: "ip_not_allowed" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an empty allowlist allows nobody", async () => {
    build();
    const out = await authenticateAdmin({ ...deps, allowlist: [] }, req(mfaToken()), ["ops"]);
    expect(out).toMatchObject({ ok: false, reason: "ip_not_allowed" });
  });

  it("no cookie, the customer cookie, a bad token and an expired token are unauthenticated", async () => {
    build();
    const cases: [AdminRequestInfo, AuthReason][] = [
      [req(null), "no_cookie"],
      [{ ...req(null), cookieHeader: `${ACCESS_COOKIE}=${mfaToken()}` }, "no_cookie"],
      [req("not.a.token"), "token_invalid"],
      [req(mfaToken({ exp: nowSec - 10, iat: nowSec - 3600 })), "token_expired"],
      [req(mfaToken({}) + "x"), "token_invalid"],
    ];
    for (const [r, reason] of cases) {
      expect(await authenticateAdmin(deps, r, ["ops"]), reason).toEqual({
        ok: false,
        error: "unauthenticated",
        reason,
      });
    }
  });

  it("a token of the customer pool is not an admin token", async () => {
    build();
    const other = createTestIssuer(clock, { pool: { userPoolId: "ap-southeast-1_OTHER0001" } });
    const out = await authenticateAdmin(deps, req(other.sign({ amr: ["mfa"] })), ["ops"]);
    expect(out).toMatchObject({ ok: false, reason: "token_invalid" });
  });

  it("an unknown sub is unauthenticated; a disabled admin is forbidden", async () => {
    build(null);
    expect(await authenticateAdmin(deps, req(mfaToken()), ["ops"])).toEqual({
      ok: false,
      error: "unauthenticated",
      reason: "unknown_subject",
    });
    build(admin({ status: "disabled" }));
    expect(await authenticateAdmin(deps, req(mfaToken()), ["ops"])).toEqual({
      ok: false,
      error: "forbidden",
      reason: "disabled",
    });
  });

  it("a status that is not exactly active is refused (R16)", async () => {
    build(admin({ status: "weird" as never }));
    expect(await authenticateAdmin(deps, req(mfaToken()), ["ops"])).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("the role guard: a role outside the list, and an empty list, are forbidden", async () => {
    build(admin({ role: "support" }));
    expect(await authenticateAdmin(deps, req(mfaToken()), ["ops", "superadmin"])).toEqual({
      ok: false,
      error: "forbidden",
      reason: "role_not_allowed",
    });
    expect(await authenticateAdmin(deps, req(mfaToken()), [])).toMatchObject({
      reason: "role_not_allowed",
    });
    expect(await authenticateAdmin(deps, req(mfaToken()), ["support"])).toMatchObject({ ok: true });
  });

  it("a session older than 8 hours since the sign-in is expired, whatever the token says", async () => {
    build();
    const old = mfaToken({
      auth_time: nowSec - 8 * 3600 - 5,
      iat: nowSec - 60,
      exp: nowSec + 3000,
    });
    expect(await authenticateAdmin(deps, req(old), ["ops"])).toEqual({
      ok: false,
      error: "unauthenticated",
      reason: "token_expired",
    });
  });

  it("a failing lookup is upstream_unavailable and never a session", async () => {
    build();
    deps = { ...deps, lookup: () => Promise.reject(new Error("db down with secret=hunter2")) };
    const out = await authenticateAdmin(deps, req(mfaToken()), ["ops"]);
    expect(out).toEqual({ ok: false, error: "upstream_unavailable", reason: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("onDenied gets an enum only and cannot change the outcome when it throws", async () => {
    build();
    deps = {
      ...deps,
      onDenied: () => {
        throw new Error("hook");
      },
    };
    expect(await authenticateAdmin(deps, req(null), ["ops"])).toMatchObject({
      ok: false,
      reason: "no_cookie",
    });
  });

  it("reads only the cookie and the viewer address: a forged actor in the request is ignored", async () => {
    build();
    const forged = { ...req(mfaToken()), adminId: "evil", role: "superadmin" } as AdminRequestInfo;
    const out = await authenticateAdmin(deps, forged, ["ops"]);
    expect(out).toMatchObject({ ok: true, actor: { adminId: ADMIN_ID, role: "ops" } });
  });
});

describe("requireAdmin", () => {
  function configure(token: string | null, found: AdminIdentity | null = admin()) {
    build(found);
    configureAdminAuth({
      config: {
        admin: issuer.pool,
        allowlist: ALLOW,
      },
      readRequest: () => Promise.resolve(req(token)),
      deps: { verifier: deps.verifier, lookup: deps.lookup },
      clock,
    });
  }

  it("resolves the AdminActor of section F", async () => {
    configure(mfaToken());
    expect(await requireAdmin(["ops"])).toEqual({
      adminId: ADMIN_ID,
      role: "ops",
      ip: "203.0.113.5",
      userAgent: "test-agent",
    });
  });

  it("rejects with an AuthError of fixed text for each refusal", async () => {
    configure(mfaToken({ amr: ["pwd"] }));
    const err = await requireAdmin(["ops"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "mfa_required",
      message: "auth: forbidden",
    });
  });

  it("rejects when it was never configured, and when the request cannot be read", async () => {
    await expect(requireAdmin(["ops"])).rejects.toMatchObject({
      code: "unauthenticated",
      reason: "not_configured",
    });
    build();
    configureAdminAuth({
      config: { admin: issuer.pool, allowlist: ALLOW },
      readRequest: () => Promise.reject(new Error("no request")),
      deps: { verifier: deps.verifier, lookup: deps.lookup },
      clock,
    });
    await expect(requireAdmin(["ops"])).rejects.toMatchObject({ reason: "no_cookie" });
  });

  it("currentAdmin never throws", async () => {
    configure(null);
    expect(await currentAdmin(["ops"])).toEqual({ ok: false, error: "unauthenticated" });
    resetAdminAuthForTests();
    expect(await currentAdmin(["ops"])).toEqual({ ok: false, error: "unauthenticated" });
  });
});
