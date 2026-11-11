import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import proxy, { config } from "./proxy.ts";

function run(path: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

function nonceOf(csp: string): string {
  const match = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp);
  if (match?.[1] === undefined) throw new Error("no nonce in the policy");
  return match[1];
}

describe("proxy: headers", () => {
  it("adds a report-only CSP and no enforced CSP header", () => {
    const response = run("/");
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("the CSP holds the nonce and the nonce differs between two requests", () => {
    const first = nonceOf(run("/").headers.get("content-security-policy-report-only") ?? "");
    const second = nonceOf(run("/").headers.get("content-security-policy-report-only") ?? "");
    expect(first).not.toBe(second);
  });

  it("forwards the nonce to the render", () => {
    const response = run("/");
    const csp = response.headers.get("content-security-policy-report-only") ?? "";
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
  });

  it("forwards the CSP to the render as a request header only", () => {
    const response = run("/");
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(response.headers.get("content-security-policy-report-only"));
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("sets Reporting-Endpoints and the four security headers", () => {
    const response = run("/en");
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
  it("serves / without a redirect, also with Accept-Language: en", () => {
    const variants: Record<string, string>[] = [{}, { "accept-language": "en-US,en;q=0.9" }];
    for (const headers of variants) {
      const response = run("/", headers);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.has("location")).toBe(false);
    }
  });

  it("serves /en and /en/x", () => {
    for (const path of ["/en", "/en/x"]) {
      const response = run(path);
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.has("location"), path).toBe(false);
    }
  });

  it("redirects /bn to /", () => {
    const response = run("/bn");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
  });

  it("redirects /bn/x to /x", () => {
    const response = run("/bn/x");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/x");
  });

  it("sets no locale cookie", () => {
    for (const path of ["/", "/en", "/bn"]) {
      const cookie = run(path, { "accept-language": "en" }).headers.get("set-cookie") ?? "";
      expect(cookie, path).not.toContain("NEXT_LOCALE");
    }
  });
});

describe("proxy: matcher", () => {
  const source = (config.matcher as string).replace(/^\//, "^/").concat("$");
  const matches = (path: string) => new RegExp(source).test(path);

  it("matches pages and excludes api, _next, _vercel and paths with a dot", () => {
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

  it("is the next-intl matcher, without the return routes of the payment gateway", () => {
    expect(config.matcher).toBe("/((?!api|trpc|_next|_vercel|pay/|.*\\..*).*)");
  });

  it("does not match /pay/eps/*: the gateway returns there, no locale, no rewrite", () => {
    for (const path of [
      "/pay/eps/success",
      "/pay/eps/fail",
      "/pay/eps/cancel",
      "/pay/eps/success?MerchantTransactionId=x",
    ]) {
      expect(matches(path.split("?")[0] as string), path).toBe(false);
    }
  });

  it("still matches the wallet pages in both locales and a path that only starts with pay", () => {
    for (const path of ["/wallet", "/en/wallet", "/wallet/topup", "/payments", "/en/pay/eps/x"]) {
      expect(matches(path), path).toBe(true);
    }
  });
});

describe("proxy: form-action", () => {
  it("lets forms post to the gateway origin and nowhere else (CSP form-action)", () => {
    const csp = run("/wallet/topup").headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain("form-action 'self' https://pg.eps.com.bd;");
    expect(csp).not.toContain("pg.eps.test");
  });
});
