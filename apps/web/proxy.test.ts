import { ACCESS_COOKIE, REFRESH_COOKIE } from "@tc/auth";
import { authConfigFromEnv } from "@tc/auth/proxy";
import type { AuthRuntimeLike } from "@tc/auth/proxy";
import type { RefreshResult } from "@tc/auth";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The refresh runtime of the proxy is replaced by a state the tests control; null (the default) is
// "not configurable", which is what every test of the headers and the routing wants.
const state = vi.hoisted(() => ({ runtime: null as unknown, refresh: null as unknown }));
vi.mock("./server/proxy-auth.ts", () => ({
  proxyAuthRuntime: async () => state.runtime,
}));

import proxy, { config } from "./proxy.ts";

beforeEach(() => {
  state.runtime = null;
});

async function run(path: string, headers: Record<string, string> = {}) {
  return await proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

function nonceOf(csp: string): string {
  const match = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp);
  if (match?.[1] === undefined) throw new Error("no nonce in the policy");
  return match[1];
}

describe("proxy: headers", () => {
  it("adds a report-only CSP and no enforced CSP header", async () => {
    const response = await run("/");
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("the CSP holds the nonce and the nonce differs between two requests", async () => {
    const first = nonceOf(
      (await run("/")).headers.get("content-security-policy-report-only") ?? "",
    );
    const second = nonceOf(
      (await run("/")).headers.get("content-security-policy-report-only") ?? "",
    );
    expect(first).not.toBe(second);
  });

  it("forwards the nonce to the render", async () => {
    const response = await run("/");
    const csp = response.headers.get("content-security-policy-report-only") ?? "";
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
  });

  it("forwards the CSP to the render as a request header only", async () => {
    const response = await run("/");
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(response.headers.get("content-security-policy-report-only"));
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("sets Reporting-Endpoints and the four security headers", async () => {
    const response = await run("/en");
    expect(response.headers.get("reporting-endpoints")).toBe('csp="/api/csp-report"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });
});

describe("proxy: locale routing (16.7)", () => {
  it("serves / without a redirect, also with Accept-Language: en", async () => {
    const variants: Record<string, string>[] = [{}, { "accept-language": "en-US,en;q=0.9" }];
    for (const headers of variants) {
      const response = await run("/", headers);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.has("location")).toBe(false);
    }
  });

  it("serves /en and /en/x", async () => {
    for (const path of ["/en", "/en/x"]) {
      const response = await run(path);
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.has("location"), path).toBe(false);
    }
  });

  it("redirects /bn to /", async () => {
    const response = await run("/bn");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
  });

  it("redirects /bn/x to /x", async () => {
    const response = await run("/bn/x");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/x");
  });

  it("sets no locale cookie", async () => {
    for (const path of ["/", "/en", "/bn"]) {
      const cookie = (await run(path, { "accept-language": "en" })).headers.get("set-cookie") ?? "";
      expect(cookie, path).not.toContain("NEXT_LOCALE");
    }
  });
});

describe("proxy: matcher", () => {
  const source = (config.matcher as string).replace(/^\//, "^/").concat("$");
  const matches = (path: string) => new RegExp(source).test(path);

  it("matches pages and excludes api, _next, _vercel and paths with a dot", async () => {
    for (const path of ["/", "/en", "/en/servers", "/bn/servers"]) {
      expect(matches(path), path).toBe(true);
    }
    for (const path of [
      "/api/csp-report",
      "/_next/static/x.js",
      "/_vercel/insights",
      "/theme/tc.css",
      "/brand/logo.svg",
      "/favicon.ico",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("is the next-intl matcher, without the return routes of the payment gateway", async () => {
    expect(config.matcher).toBe("/((?!api|trpc|_next|_vercel|pay/|dev/(?:idp|sms)/|.*\\..*).*)");
  });

  it("does not match /pay/eps/*: the gateway returns there, no locale, no rewrite", async () => {
    for (const path of [
      "/pay/eps/success",
      "/pay/eps/fail",
      "/pay/eps/cancel",
      "/pay/eps/success?MerchantTransactionId=x",
    ]) {
      expect(matches(path.split("?")[0] as string), path).toBe(false);
    }
  });

  it("does not match the two dev outbox routes, and still matches the dev UI pages", async () => {
    for (const path of ["/dev/idp/outbox", "/dev/sms/outbox"]) {
      expect(matches(path), path).toBe(false);
    }
    for (const path of ["/dev/ui", "/en/dev/ui", "/dev/identity"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("still matches the wallet pages in both locales and a path that only starts with pay", async () => {
    for (const path of ["/wallet", "/en/wallet", "/wallet/topup", "/payments", "/en/pay/eps/x"]) {
      expect(matches(path), path).toBe(true);
    }
  });
});

describe("proxy: form-action", () => {
  it("lets forms post to the gateway origin and nowhere else (CSP form-action)", async () => {
    const csp =
      (await run("/wallet/topup")).headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain("form-action 'self' https://pg.eps.com.bd;");
    expect(csp).not.toContain("pg.eps.test");
  });
});

describe("proxy: session refresh (open point 20)", () => {
  const authConfig = authConfigFromEnv({
    COGNITO_CUSTOMER_POOL_ID: "ap-southeast-1_AbCdEf123",
    COGNITO_CUSTOMER_CLIENT_ID: "abcdefghij1234567890",
  });
  const now = Date.now();
  const clock = { now: () => new Date(now) };
  const jwt = (expSeconds: number) =>
    `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
  const expiring = jwt(Math.floor(now / 1000) + 10);
  const fresh = jwt(Math.floor(now / 1000) + 3600);
  const verifier = {
    verify: async () => ({
      ok: true as const,
      token: {
        sub: "sub-1",
        issuedAt: new Date(now),
        authTime: new Date(now),
        expiresAt: new Date(now + 3_600_000),
      },
    }),
  };
  const runtimeWith = (answer: RefreshResult | Error): AuthRuntimeLike => ({
    config: authConfig,
    clock,
    verifier,
    port: {
      refresh: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  });
  const cookieHeader = (access: string) =>
    `theme=dark; ${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=refresh-1`;

  it("an access token about to expire gets the refreshed cookies on the request and on the response", async () => {
    state.runtime = runtimeWith({ kind: "refreshed", accessToken: "new.access.token" });
    const response = await run("/wallet", { cookie: cookieHeader(expiring) });
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toContain(`${ACCESS_COOKIE}=new.access.token`);
    expect(forwarded).toContain("theme=dark");
    expect(forwarded).not.toContain(expiring);
    const setCookies = response.headers.getSetCookie();
    // Cognito did not rotate the refresh token, so only the access cookie is written again.
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(new RegExp(`^${ACCESS_COOKIE}=new\\.access\\.token;`));
    expect(setCookies.join("\n")).toMatch(/HttpOnly/);
    expect(setCookies.join("\n")).toMatch(/Secure/);
    expect(setCookies.join("\n")).toMatch(/SameSite=Lax/);
    expect(setCookies.join("\n")).not.toMatch(/Domain=/);
  });

  it("a fresh token (none) leaves the request cookies as they were and sets nothing", async () => {
    state.runtime = runtimeWith({ kind: "refreshed", accessToken: "never-used" });
    const original = cookieHeader(fresh);
    const response = await run("/wallet", { cookie: original });
    expect(response.headers.get("x-middleware-request-cookie")).toBe(original);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("a request without cookies is untouched", async () => {
    state.runtime = runtimeWith({ kind: "refreshed", accessToken: "never-used" });
    const response = await run("/wallet");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("a refresh token that Cognito rejects clears both cookies and removes them from the request", async () => {
    state.runtime = runtimeWith({ kind: "rejected" });
    const response = await run("/wallet", { cookie: cookieHeader(expiring) });
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies.join("\n")).toMatch(/Max-Age=0/);
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toBe("theme=dark");
  });

  it("Cognito unreachable keeps the cookies, and the request still reaches i18n with the CSP and the nonce", async () => {
    for (const answer of [{ kind: "unavailable" } as const, new Error("network down")]) {
      state.runtime = runtimeWith(answer);
      const original = cookieHeader(expiring);
      const response = await run("/en/wallet", { cookie: original });
      expect(response.headers.get("x-middleware-request-cookie")).toBe(original);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get("content-security-policy-report-only")).toContain("nonce-");
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    }
  });

  it("a runtime that cannot be built (null) refreshes nothing", async () => {
    state.runtime = null;
    const original = cookieHeader(expiring);
    const response = await run("/wallet", { cookie: original });
    expect(response.headers.get("x-middleware-request-cookie")).toBe(original);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("the CSP and the security headers are still set after a refresh", async () => {
    state.runtime = runtimeWith({ kind: "refreshed", accessToken: "new.access.token" });
    const response = await run("/wallet", { cookie: cookieHeader(expiring) });
    expect(response.headers.get("content-security-policy-report-only")).toContain("default-src");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
