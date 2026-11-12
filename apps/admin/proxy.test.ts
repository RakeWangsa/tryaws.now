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
    const response = run("/", { "cloudfront-viewer-address": "198.51.100.1:80" });
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
    expect(run("/").status).toBeLessThan(300);
  });
});

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

// The loop of WPU-T4: the proxy rewrites `/x` to `/bn/x`. When the server hands that rewrite to the
// proxy again (the router takes it for a request of its own), next-intl sees the default locale in
// the path and redirects `/bn/x` back to `/x`: a 307 to the very path the visitor asked for. The
// second pass has to be harmless: it serves the request and never redirects.
describe("proxy: its own rewrite, handed to it again (no self-redirect)", () => {
  // What the server forwards to the second pass: the rewrite target, the request headers and the
  // `x-middleware-request-*` overrides of the first pass applied to them.
  function secondPass(path: string) {
    const first = run(path);
    const target = first.headers.get("x-middleware-rewrite");
    if (target === null) throw new Error(`${path} is not rewritten`);
    const headers: Record<string, string> = { "cloudfront-viewer-address": ALLOWED };
    for (const [name, value] of first.headers) {
      if (name.startsWith("x-middleware-request-")) {
        headers[name.slice("x-middleware-request-".length)] = value;
      }
    }
    return proxy(new NextRequest(target, { headers }));
  }

  it("a path of the default locale and an unknown path are served by the second pass", () => {
    for (const path of ["/", "/customers", "/this-path-does-not-exist", "/login"]) {
      const response = secondPass(path);
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.has("location"), path).toBe(false);
    }
  });

  it("the second pass keeps the security headers and a fresh nonce", () => {
    const response = secondPass("/this-path-does-not-exist");
    expect(response.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
  });

  it("the second pass still checks the allowlist", () => {
    const first = run("/this-path-does-not-exist");
    const target = first.headers.get("x-middleware-rewrite") ?? "";
    const response = proxy(
      new NextRequest(target, {
        headers: { "x-tc-proxied": "1", "cloudfront-viewer-address": "198.51.100.1:80" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("a visitor request for /bn/x is still redirected to /x", () => {
    const response = run("/bn/this-path-does-not-exist");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/this-path-does-not-exist",
    );
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
