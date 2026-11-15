import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxy, { config } from "./proxy.ts";

const ALLOWED = "203.0.113.5:44321";

beforeEach(() => {
  vi.stubEnv("ADMIN_IP_ALLOWLIST", "203.0.113.0/24");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Every request comes from an allowed address unless the test says otherwise (6.2).
function run(path: string, headers: Record<string, string> = {}) {
  return proxy(
    new NextRequest(`http://localhost:3001${path}`, {
      headers: { "cloudfront-viewer-address": ALLOWED, ...headers },
    }),
  );
}

describe("proxy: the IP allowlist (6.2, R10)", () => {
  it("outside the allowlist gets 403 with no body, no locale work and no CSP nonce", () => {
    const response = run("/en", { "cloudfront-viewer-address": "198.51.100.1:80" });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("x-middleware-request-x-nonce")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
  });

  it("no CloudFront header at all (a direct request to the function URL) gets 403", () => {
    const response = proxy(new NextRequest("http://localhost:3001/en/customers"));
    expect(response.status).toBe(403);
  });

  it("an unreadable header gets 403 on every page path", () => {
    for (const path of ["/", "/en", "/login", "/en/payments", "/bn/x"]) {
      expect(run(path, { "cloudfront-viewer-address": "garbage" }).status, path).toBe(403);
    }
  });

  it("with no allowlist configured every request gets 403 (R16)", () => {
    vi.stubEnv("ADMIN_IP_ALLOWLIST", "");
    expect(run("/").status).toBe(403);
  });

  it("inside the allowlist the page is served", () => {
    expect(run("/en").status).toBeLessThan(300);
  });
});

function nonceOf(csp: string): string {
  const match = /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(csp);
  if (match?.[1] === undefined) throw new Error("no nonce in the policy");
  return match[1];
}

describe("proxy: headers", () => {
  it("adds a report-only CSP and no enforced CSP header", () => {
    const response = run("/en");
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("the CSP holds the nonce and the nonce differs between two requests", () => {
    const first = nonceOf(run("/en").headers.get("content-security-policy-report-only") ?? "");
    const second = nonceOf(run("/en").headers.get("content-security-policy-report-only") ?? "");
    expect(first).not.toBe(second);
  });

  it("forwards the nonce to the render", () => {
    const response = run("/en");
    const csp = response.headers.get("content-security-policy-report-only") ?? "";
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
  });

  it("forwards the CSP to the render as a request header only", () => {
    const response = run("/en");
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

// WPU-X22 (owner, 2026-11-15): the admin console is English only. Whatever would be served in bn goes
// with 308 to the same path under /en, query kept; the allowlist still comes first.
describe("proxy: English only (WPU-X22)", () => {
  it("redirects /, /x and /bn/x to /en, /en/x and /en/x with 308 and keeps the query", () => {
    const cases: [string, string][] = [
      ["/", "/en"],
      ["/customers?q=a&page=2", "/en/customers"],
      ["/bn/customers?q=a", "/en/customers"],
      ["/bn", "/en"],
      ["/login?next=/payments", "/en/login"],
    ];
    for (const [path, target] of cases) {
      const response = run(path, { "accept-language": "bn" });
      expect(response.status, path).toBe(308);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname, path).toBe(target);
      expect(location.origin, path).toBe("http://localhost:3001");
      expect(location.search, path).toBe(new URL(`http://x${path}`).search);
    }
  });

  it("a hostile double-slash path stays on the same origin", () => {
    const response = run("//evil.example/x");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("http://localhost:3001");
  });

  it("serves /en and /en/x as they are", () => {
    for (const path of ["/en", "/en/x", "/en/login"]) {
      const response = run(path);
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.has("location"), path).toBe(false);
    }
  });

  it("the redirect carries the security headers and a report-only CSP", () => {
    const response = run("/customers");
    expect(response.status).toBe(308);
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("the allowlist is checked before the redirect", () => {
    const response = run("/customers", { "cloudfront-viewer-address": "198.51.100.1:80" });
    expect(response.status).toBe(403);
    expect(response.headers.has("location")).toBe(false);
  });

  it("sets no locale cookie", () => {
    for (const path of ["/", "/en", "/bn"]) {
      const cookie = run(path, { "accept-language": "en" }).headers.get("set-cookie") ?? "";
      expect(cookie, path).not.toContain("NEXT_LOCALE");
    }
  });

  it("a request that already went through the proxy is served, the allowlist still applies", () => {
    const served = proxy(
      new NextRequest("http://localhost:3001/en/x", {
        headers: { "x-tc-proxied": "1", "cloudfront-viewer-address": ALLOWED },
      }),
    );
    expect(served.status).toBeLessThan(300);
    const denied = proxy(
      new NextRequest("http://localhost:3001/en/x", {
        headers: { "x-tc-proxied": "1", "cloudfront-viewer-address": "198.51.100.1:80" },
      }),
    );
    expect(denied.status).toBe(403);
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

  it("is the next-intl matcher", () => {
    expect(config.matcher).toBe("/((?!api|trpc|_next|_vercel|.*\\..*).*)");
  });
});
