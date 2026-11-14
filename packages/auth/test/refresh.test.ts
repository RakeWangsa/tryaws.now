import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authConfigFromEnv, type AuthConfig } from "../config";
import { ACCESS_COOKIE, REFRESH_COOKIE, parseCookieHeader } from "../cookies";
import { requireFreshSignIn } from "../fresh";
import { authenticateCustomer, type SessionDeps } from "../session";
import {
  cognitoRefreshPort,
  needsRefresh,
  refreshSession,
  type RefreshPort,
  type RefreshResult,
} from "../refresh";
import { createAccessTokenVerifier, type AccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

// A whole second, so a token with exactly N seconds left is exact.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock = { now: () => NOW };
const nowSec = Math.floor(NOW.getTime() / 1000);

let issuer: TestIssuer;
let verifier: AccessTokenVerifier;
let config: AuthConfig;
// WPU-X12 round 4: the customer app client has a secret; the refresh port sends it as ClientSecret of
// GetTokensFromRefreshToken (no username is needed, a SECRET_HASH of REFRESH_TOKEN_AUTH needs the sub,
// which is unknown when only the refresh cookie is left). A made-up value, not a real client.
const CLIENT_SECRET = "customer0app0client0secret0abcdef";
let client: { readonly clientId: string; readonly clientSecret: string };

beforeAll(() => {
  issuer = createTestIssuer(clock);
  client = { clientId: issuer.pool.clientId, clientSecret: CLIENT_SECRET };
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
  config = {
    ...authConfigFromEnv({
      COGNITO_CUSTOMER_POOL_ID: issuer.pool.userPoolId,
      COGNITO_CUSTOMER_CLIENT_ID: issuer.pool.clientId,
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const OLD_REFRESH = "old1.old2.old3.old4.old5";

function cookies(access?: string, refresh?: string): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  if (access !== undefined) m.set(ACCESS_COOKIE, access);
  if (refresh !== undefined) m.set(REFRESH_COOKIE, refresh);
  return m;
}

function header(
  access?: string,
  refresh: string | undefined = OLD_REFRESH,
  other = "theme=dark",
): string {
  return [
    other,
    access !== undefined && `${ACCESS_COOKIE}=${access}`,
    refresh && `${REFRESH_COOKIE}=${refresh}`,
  ]
    .filter(Boolean)
    .join("; ");
}

const portReturning = (result: RefreshResult): RefreshPort => ({
  refresh: () => Promise.resolve(result),
});

function cognitoAnswer(accessToken: string, refreshToken?: string): Response {
  return new Response(
    JSON.stringify({
      AuthenticationResult: {
        AccessToken: accessToken,
        ExpiresIn: 3600,
        TokenType: "Bearer",
        ...(refreshToken ? { RefreshToken: refreshToken } : {}),
      },
      ChallengeParameters: {},
    }),
    { status: 200, headers: { "Content-Type": "application/x-amz-json-1.1" } },
  );
}

describe("needsRefresh", () => {
  const withLeft = (seconds: number) => issuer.sign({ exp: nowSec + seconds });

  it("needsRefresh: a token with an hour left does not need one", () => {
    expect(needsRefresh(cookies(withLeft(3600), OLD_REFRESH), clock, 300)).toBe(false);
  });

  it("needsRefresh: a token with 299 seconds left needs one", () => {
    expect(needsRefresh(cookies(withLeft(299), OLD_REFRESH), clock, 300)).toBe(true);
  });

  it("needsRefresh: a token with exactly 300 seconds left needs one", () => {
    expect(needsRefresh(cookies(withLeft(300), OLD_REFRESH), clock, 300)).toBe(true);
    expect(needsRefresh(cookies(withLeft(301), OLD_REFRESH), clock, 300)).toBe(false);
  });

  it("needsRefresh: an already expired token needs one", () => {
    expect(needsRefresh(cookies(withLeft(-5), OLD_REFRESH), clock, 300)).toBe(true);
  });

  it("needsRefresh: no access cookie with a refresh cookie needs one", () => {
    expect(needsRefresh(cookies(undefined, OLD_REFRESH), clock, 300)).toBe(true);
  });

  it("needsRefresh: neither cookie needs nothing", () => {
    expect(needsRefresh(cookies(), clock, 300)).toBe(false);
    expect(needsRefresh(cookies(undefined, ""), clock, 300)).toBe(false);
  });

  it("needsRefresh: an unreadable access token counts as needing one", () => {
    for (const bad of [
      "not-a-jwt",
      "a.b.c",
      "a.%%%.c",
      `a.${Buffer.from("[1]").toString("base64url")}.c`,
      "x".repeat(9000),
    ]) {
      expect(needsRefresh(cookies(bad, OLD_REFRESH), clock, 300)).toBe(true);
    }
    const noExp = issuer.sign({ exp: undefined });
    expect(needsRefresh(cookies(noExp, OLD_REFRESH), clock, 300)).toBe(true);
  });
});

describe("refreshSession", () => {
  const deps = (port: RefreshPort, v: AccessTokenVerifier = verifier) => ({
    port,
    verifier: v,
    clock,
    config,
  });

  it("refreshSession returns none when there is no refresh cookie", async () => {
    const port = { refresh: vi.fn() };
    const out = await refreshSession(deps(port), header(issuer.sign(), ""));
    expect(out).toEqual({ action: "none" });
    expect(port.refresh).not.toHaveBeenCalled();
    expect(await refreshSession(deps(port), null)).toEqual({ action: "none" });
    expect(await refreshSession(deps(port), undefined)).toEqual({ action: "none" });
  });

  it("a refreshed access token is verified before it is stored", async () => {
    const verify = vi.fn(verifier.verify.bind(verifier));
    const fresh = issuer.sign();
    const out = await refreshSession(
      deps(portReturning({ kind: "refreshed", accessToken: fresh }), { verify }),
      header(),
    );
    expect(verify).toHaveBeenCalledWith(fresh);
    expect(out.action).toBe("set");
  });

  it("a refreshed token that does not verify is not stored and the outcome is none", async () => {
    const bad = [
      issuer.sign({}, { key: "other" }),
      issuer.sign({ exp: nowSec - 3600 }),
      issuer.sign({ client_id: "someotherclient0123456789" }),
      "not-a-jwt",
    ];
    for (const accessToken of bad) {
      const out = await refreshSession(
        deps(portReturning({ kind: "refreshed", accessToken })),
        header(),
      );
      expect(out).toEqual({ action: "none" });
    }
  });

  it("on success the Set-Cookie strings are HttpOnly, Secure, SameSite=Lax", async () => {
    const out = await refreshSession(
      deps(
        portReturning({
          kind: "refreshed",
          accessToken: issuer.sign(),
          refreshToken: "new1.new2.new3.new4.new5",
        }),
      ),
      header(),
    );
    expect(out.action).toBe("set");
    if (out.action !== "set") return;
    expect(out.setCookies).toHaveLength(2);
    for (const c of out.setCookies) {
      expect(c).toMatch(/; Secure(;|$)/);
      expect(c).toMatch(/; HttpOnly(;|$)/);
      expect(c).toMatch(/; SameSite=Lax(;|$)/);
      expect(c).toMatch(/; Path=\/(;|$)/);
      expect(c).not.toMatch(/domain/i);
    }
    expect(out.setCookies[0]).toContain("; Max-Age=3600;");
    expect(out.setCookies[1]).toContain(`; Max-Age=${config.refreshCookieMaxAgeSeconds};`);
  });

  it("on success the forwarded Cookie header carries the new access token, so the same request renders signed in", async () => {
    const stale = issuer.sign({ exp: nowSec + 100 });
    const fresh = issuer.sign({ exp: nowSec + 3600 });
    const out = await refreshSession(
      deps(portReturning({ kind: "refreshed", accessToken: fresh })),
      header(stale),
    );
    if (out.action !== "set") throw new Error("expected set");
    const forwarded = parseCookieHeader(out.cookieHeader);
    expect(forwarded.get(ACCESS_COOKIE)).toBe(fresh);
    expect(forwarded.get("theme")).toBe("dark");
    expect(out.cookieHeader.match(/__Host-tc_at=/g)).toHaveLength(1);
    // and the missing-access-cookie case, which is the other reason to refresh
    const out2 = await refreshSession(
      deps(portReturning({ kind: "refreshed", accessToken: fresh })),
      header(undefined),
    );
    if (out2.action !== "set") throw new Error("expected set");
    expect(parseCookieHeader(out2.cookieHeader).get(ACCESS_COOKIE)).toBe(fresh);
  });

  it("a rotated refresh token replaces the old one; an absent one keeps the old one", async () => {
    const rotated = await refreshSession(
      deps(
        portReturning({
          kind: "refreshed",
          accessToken: issuer.sign(),
          refreshToken: "new1.new2.new3.new4.new5",
        }),
      ),
      header(),
    );
    if (rotated.action !== "set") throw new Error("expected set");
    expect(
      rotated.setCookies.some((c) => c.startsWith(`${REFRESH_COOKIE}=new1.new2.new3.new4.new5;`)),
    ).toBe(true);
    expect(parseCookieHeader(rotated.cookieHeader).get(REFRESH_COOKIE)).toBe(
      "new1.new2.new3.new4.new5",
    );

    const kept = await refreshSession(
      deps(portReturning({ kind: "refreshed", accessToken: issuer.sign() })),
      header(),
    );
    if (kept.action !== "set") throw new Error("expected set");
    expect(kept.setCookies).toHaveLength(1);
    expect(kept.setCookies.some((c) => c.startsWith(REFRESH_COOKIE))).toBe(false);
    expect(parseCookieHeader(kept.cookieHeader).get(REFRESH_COOKIE)).toBe(OLD_REFRESH);
  });

  it("a rejected refresh token clears both cookies", async () => {
    const out = await refreshSession(
      deps(portReturning({ kind: "rejected" })),
      header(issuer.sign()),
    );
    expect(out.action).toBe("clear");
    if (out.action !== "clear") return;
    expect(out.setCookies).toHaveLength(2);
    for (const c of out.setCookies) {
      expect(c).toContain("; Max-Age=0;");
      expect(c).toMatch(/; HttpOnly(;|$)/);
    }
    const forwarded = parseCookieHeader(out.cookieHeader);
    expect(forwarded.has(ACCESS_COOKIE)).toBe(false);
    expect(forwarded.has(REFRESH_COOKIE)).toBe(false);
    expect(forwarded.get("theme")).toBe("dark");
  });

  it("an unreachable Cognito (timeout, network error, 500) keeps the cookies", async () => {
    const failures: Array<() => Promise<Response>> = [
      () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve(new Response("oops", { status: 500 })),
      () => Promise.resolve(new Response("{}", { status: 503 })),
    ];
    for (const f of failures) {
      const port = cognitoRefreshPort(issuer.pool, client, f as typeof fetch);
      expect(await refreshSession(deps(port), header(issuer.sign()))).toEqual({ action: "none" });
    }
  });

  it("a malformed answer is unavailable, not rejected", async () => {
    const answers = [
      new Response("not json", { status: 200 }),
      new Response("{}", { status: 200 }),
      new Response(JSON.stringify({ AuthenticationResult: {} }), { status: 200 }),
      new Response(JSON.stringify({ AuthenticationResult: { AccessToken: 5 } }), { status: 200 }),
      new Response(JSON.stringify({ AuthenticationResult: { AccessToken: "" } }), { status: 200 }),
      new Response(JSON.stringify({ __type: "InvalidParameterException" }), { status: 400 }),
      new Response("not json", { status: 400 }),
    ];
    for (const r of answers) {
      const port = cognitoRefreshPort(issuer.pool, client, (() =>
        Promise.resolve(r)) as typeof fetch);
      expect(await port.refresh(OLD_REFRESH)).toEqual({ kind: "unavailable" });
    }
  });

  it("refreshSession never throws", async () => {
    const boom = new TypeError(`leak ${OLD_REFRESH}`);
    const throwingPort: RefreshPort = {
      refresh: () => {
        throw boom;
      },
    };
    const rejectingPort: RefreshPort = { refresh: () => Promise.reject(boom) };
    const throwingVerifier: AccessTokenVerifier = { verify: () => Promise.reject(boom) };
    const results = await Promise.all([
      refreshSession(deps(throwingPort), header()),
      refreshSession(deps(rejectingPort), header()),
      refreshSession(
        deps(portReturning({ kind: "refreshed", accessToken: issuer.sign() }), throwingVerifier),
        header(),
      ),
      refreshSession(
        deps(
          portReturning({
            kind: "refreshed",
            accessToken: issuer.sign(),
            refreshToken: "bad token;x",
          }),
        ),
        header(),
      ),
    ]);
    for (const r of results) {
      expect(r).toEqual({ action: "none" });
      expect(JSON.stringify(r)).not.toContain(OLD_REFRESH);
    }
  });

  it("refresh does not renew auth_time", async () => {
    // The fake Cognito issues a new access token (new iat) that keeps the auth_time of the original
    // sign-in, as VERIFY 2 expects of the real service. The semantics of open point 5: a refresh is
    // not a fresh sign-in, so the session's signedInAt (the auth_time) stays old.
    const signedInSec = nowSec - 3000;
    const fresh = issuer.sign({ iat: nowSec, auth_time: signedInSec, exp: nowSec + 3600 });
    const out = await refreshSession(
      deps(portReturning({ kind: "refreshed", accessToken: fresh })),
      header(),
    );
    if (out.action !== "set") throw new Error("expected set");
    const stored = parseCookieHeader(out.cookieHeader).get(ACCESS_COOKIE);
    const verified = await verifier.verify(stored);
    if (!verified.ok) throw new Error("expected a valid token");
    expect(verified.token.issuedAt).toEqual(new Date(nowSec * 1000));

    // The request after the refresh: the real pipeline reads the stored cookie. The session keeps the
    // old sign-in time, so requireFreshSignIn (10 minutes) refuses it although the token is new.
    const lookup = vi.fn<SessionDeps["lookup"]>(() =>
      Promise.resolve({
        id: "0191a000-0000-7000-8000-00000000000a",
        status: "active" as const,
        sessionsValidAfter: null,
        kycStatus: "verified" as const,
        riskTier: "new" as const,
        locale: "bn" as const,
      }),
    );
    const session = await authenticateCustomer({ verifier, lookup }, out.cookieHeader);
    if (!session.ok) throw new Error("expected a session");
    expect(session.session.signedInAt).toEqual(new Date(signedInSec * 1000));
    expect(requireFreshSignIn(session.session, clock)).toMatchObject({
      ok: false,
      error: "unauthenticated",
    });
  });
});

describe("cognitoRefreshPort", () => {
  it("cognitoRefreshPort sends the documented request and nothing else", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(cognitoAnswer("a.b.c"));
    }) as unknown as typeof fetch;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await cognitoRefreshPort(issuer.pool, client, fake).refresh(OLD_REFRESH);
    expect(result).toEqual({ kind: "refreshed", accessToken: "a.b.c" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://cognito-idp.ap-southeast-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["content-type", "x-amz-target"]);
    expect(headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(headers.get("x-amz-target")).toBe(
      "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
    );
    expect(headers.has("authorization")).toBe(false);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ClientId", "ClientSecret", "RefreshToken"]);
    expect(body["ClientId"]).toBe(issuer.pool.clientId);
    expect(body["ClientSecret"]).toBe(CLIENT_SECRET);
    expect(body["RefreshToken"]).toBe(OLD_REFRESH);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(3000);
  });

  it("a rotated refresh token in the answer is returned", async () => {
    const fake = (() =>
      Promise.resolve(cognitoAnswer("a.b.c", "n1.n2.n3.n4.n5"))) as unknown as typeof fetch;
    expect(await cognitoRefreshPort(issuer.pool, client, fake).refresh(OLD_REFRESH)).toEqual({
      kind: "refreshed",
      accessToken: "a.b.c",
      refreshToken: "n1.n2.n3.n4.n5",
    });
  });

  // A dead refresh cookie (the user was deleted: UserNotFoundException) is cleared, not retried on every
  // request (round 5, re-review L3).
  it("a NotAuthorized, RefreshTokenReuse or UserNotFound answer is rejected", async () => {
    for (const type of [
      "NotAuthorizedException",
      "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException",
      "RefreshTokenReuseException",
      "UserNotFoundException",
      "com.amazonaws.cognito.identity.idp.model#UserNotFoundException",
    ]) {
      const fake = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ __type: type, message: "Refresh Token has been revoked" }),
            { status: 400 },
          ),
        )) as unknown as typeof fetch;
      expect(await cognitoRefreshPort(issuer.pool, client, fake).refresh(OLD_REFRESH)).toEqual({
        kind: "rejected",
      });
    }
  });

  it("the client secret is in no result and no error", async () => {
    const answers = [
      () => Promise.reject(new TypeError(`failed with ${CLIENT_SECRET}`)),
      () => Promise.resolve(new Response(`{"message":"${CLIENT_SECRET}"}`, { status: 500 })),
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ __type: "NotAuthorizedException", message: CLIENT_SECRET }),
            {
              status: 400,
            },
          ),
        ),
    ];
    for (const answer of answers) {
      const result = await cognitoRefreshPort(
        issuer.pool,
        client,
        answer as unknown as typeof fetch,
      ).refresh(OLD_REFRESH);
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    }
  });

  it("cognitoRefreshPort never puts the refresh token in an error", async () => {
    const fake = (() =>
      Promise.reject(new TypeError(`failed for ${OLD_REFRESH}`))) as unknown as typeof fetch;
    let result: RefreshResult | undefined;
    await expect(
      (async () => {
        result = await cognitoRefreshPort(issuer.pool, client, fake).refresh(OLD_REFRESH);
      })(),
    ).resolves.toBeUndefined();
    expect(result).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(OLD_REFRESH);

    const synchronous = (() => {
      throw new TypeError(`sync ${OLD_REFRESH}`);
    }) as unknown as typeof fetch;
    expect(await cognitoRefreshPort(issuer.pool, client, synchronous).refresh(OLD_REFRESH)).toEqual(
      {
        kind: "unavailable",
      },
    );
  });
});
