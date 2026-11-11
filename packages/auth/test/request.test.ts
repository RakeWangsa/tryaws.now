import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomerIdentity } from "@tc/db";
import { authConfigFromEnv, type AuthConfig } from "../config";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../cookies";
import type { RefreshPort, RefreshResult } from "../refresh";
import { authenticateRequest, refreshForProxy, type AuthRuntimeLike } from "../request";
import { createAccessTokenVerifier, type AccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock = { now: () => NOW };
const nowSec = Math.floor(NOW.getTime() / 1000);

let issuer: TestIssuer;
let verifier: AccessTokenVerifier;
let config: AuthConfig;

beforeAll(() => {
  issuer = createTestIssuer(clock);
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
  config = authConfigFromEnv({
    COGNITO_CUSTOMER_POOL_ID: issuer.pool.userPoolId,
    COGNITO_CUSTOMER_CLIENT_ID: issuer.pool.clientId,
  });
});

const ID_A = "0191a000-0000-7000-8000-00000000000a";
const ID_B = "0191a000-0000-7000-8000-00000000000b";

function identity(id = ID_A): CustomerIdentity {
  return {
    id,
    status: "active",
    sessionsValidAfter: null,
    kycStatus: "verified",
    riskTier: "trusted",
    locale: "en",
  };
}

function runtime(over: Partial<AuthRuntimeLike> = {}): AuthRuntimeLike {
  return {
    config,
    clock,
    verifier,
    lookup: () => Promise.resolve(identity()),
    ...over,
  };
}

const req = (cookie?: string, extra: Record<string, string> = {}) => ({
  headers: new Headers({ ...(cookie !== undefined ? { cookie } : {}), ...extra }),
});

function portOf(result: RefreshResult) {
  const refresh = vi.fn<RefreshPort["refresh"]>(() => Promise.resolve(result));
  return { port: { refresh } as RefreshPort, refresh };
}

describe("authenticateRequest", () => {
  it("authenticateRequest reads the Cookie header of the request", async () => {
    const out = await authenticateRequest(
      runtime(),
      req(`theme=dark; ${ACCESS_COOKIE}=${issuer.sign()}`),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.session.customerId).toBe(ID_A);
  });

  it("a request with no Cookie header is unauthenticated", async () => {
    const out = await authenticateRequest(runtime(), req());
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "no_cookie" });
  });

  it("a request cannot choose its customer: the Authorization header, the X-Customer-Id header and the Origin header are ignored", async () => {
    const lookup = vi.fn((sub: string) => {
      void sub;
      return Promise.resolve(identity(ID_A));
    });
    const other = issuer.sign({ sub: "someone-else" });
    const out = await authenticateRequest(
      runtime({ lookup }),
      req(`${ACCESS_COOKIE}=${issuer.sign({ sub: "the-sub" })}`, {
        authorization: `Bearer ${other}`,
        "x-customer-id": ID_B,
        origin: "https://evil.example",
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.session.customerId).toBe(ID_A);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("the-sub");
    // Without the cookie the same headers give nothing.
    const bare = await authenticateRequest(
      runtime({ lookup }),
      req(undefined, { authorization: `Bearer ${other}`, "x-customer-id": ID_B }),
    );
    expect(bare.ok).toBe(false);
  });

  it("the adapter never throws", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const throwingHeaders = { headers: { get: boom } as unknown as Headers };
    await expect(authenticateRequest(runtime(), throwingHeaders)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      authenticateRequest(runtime(), undefined as unknown as { headers: Headers }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      refreshForProxy(runtime({ port: { refresh: boom } }), throwingHeaders),
    ).resolves.toEqual({ action: "none" });
    await expect(
      refreshForProxy(runtime(), undefined as unknown as { headers: Headers }),
    ).resolves.toEqual({ action: "none" });
    const lookupFails = runtime({ lookup: () => Promise.reject(new Error("db down")) });
    await expect(
      authenticateRequest(lookupFails, req(`${ACCESS_COOKIE}=${issuer.sign()}`)),
    ).resolves.toMatchObject({ ok: false, error: "upstream_unavailable" });
  });
});

describe("refreshForProxy", () => {
  const OLD_REFRESH = "old1.old2.old3.old4.old5";

  it("refreshForProxy sets the cookies and forwards the new Cookie header when the access token is near its end", async () => {
    const nearEnd = issuer.sign({ exp: nowSec + 60 });
    const fresh = issuer.sign({ exp: nowSec + 3600 });
    const { port, refresh } = portOf({ kind: "refreshed", accessToken: fresh });
    const out = await refreshForProxy(
      runtime({ port }),
      req(`theme=dark; ${ACCESS_COOKIE}=${nearEnd}; ${REFRESH_COOKIE}=${OLD_REFRESH}`),
    );
    expect(refresh).toHaveBeenCalledWith(OLD_REFRESH);
    if (out.action !== "set") throw new Error("expected set");
    expect(out.setCookies[0]).toContain(`${ACCESS_COOKIE}=${fresh}`);
    expect(out.cookieHeader).toContain(`${ACCESS_COOKIE}=${fresh}`);
    expect(out.cookieHeader).toContain("theme=dark");
    expect(out.cookieHeader).not.toContain(nearEnd);
  });

  it("refreshForProxy returns none for a fresh token", async () => {
    const { port, refresh } = portOf({ kind: "refreshed", accessToken: issuer.sign() });
    const out = await refreshForProxy(
      runtime({ port }),
      req(
        `${ACCESS_COOKIE}=${issuer.sign({ exp: nowSec + 3600 })}; ${REFRESH_COOKIE}=${OLD_REFRESH}`,
      ),
    );
    expect(out).toEqual({ action: "none" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshForProxy returns clear when the refresh token is rejected", async () => {
    const { port } = portOf({ kind: "rejected" });
    const out = await refreshForProxy(
      runtime({ port }),
      req(`theme=dark; ${REFRESH_COOKIE}=${OLD_REFRESH}`),
    );
    if (out.action !== "clear") throw new Error("expected clear");
    expect(out.setCookies).toHaveLength(2);
    expect(out.cookieHeader).toBe("theme=dark");
  });

  it("refreshForProxy returns none without any cookie", async () => {
    const { port, refresh } = portOf({ kind: "rejected" });
    expect(await refreshForProxy(runtime({ port }), req())).toEqual({ action: "none" });
    expect(refresh).not.toHaveBeenCalled();
  });
});
