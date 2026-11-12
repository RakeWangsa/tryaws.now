import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WebConfig } from "./config.ts";
import { NEXT_PREFIXES, assertSameOrigin, clientIpOf, requestId, safeNext } from "./request.ts";

const prod: WebConfig = {
  stage: "production",
  appOrigin: "https://cloud.example.com",
  epsMode: "production",
  fakes: false,
  fake: { eps: false, idp: false, sms: false },
};
const fake: WebConfig = {
  stage: "local",
  appOrigin: "http://localhost:3000",
  epsMode: "sandbox",
  fakes: true,
  fake: { eps: true, idp: false, sms: false },
};

describe("safeNext (U12)", () => {
  it("passes a relative path on the allow-list, query kept", () => {
    expect(safeNext("/wallet")).toBe("/wallet");
    expect(safeNext("/wallet/topup?x=1")).toBe("/wallet/topup?x=1");
    expect(safeNext("/servers/abc")).toBe("/servers/abc");
    for (const prefix of NEXT_PREFIXES) expect(safeNext(prefix), prefix).toBe(prefix);
  });

  it("lists the panel routes that are safe redirect targets (WPU-N1)", () => {
    expect([...NEXT_PREFIXES]).toEqual([
      "/dashboard",
      "/wallet",
      "/orders",
      "/servers",
      "/invoices",
      "/settings",
      "/support",
      "/kyc",
      "/dns",
      "/domains",
      "/databases",
      "/storage",
      "/load-balancers",
      "/containers",
      "/cdn",
      "/billing",
      "/snapshots",
      "/static-ips",
      "/notifications",
    ]);
  });

  it("every prefix is a real route of the customer panel, and every panel route is a prefix", () => {
    const panel = join(import.meta.dirname, "../app/[locale]/(panel)");
    const routes = readdirSync(panel, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => `/${d.name}`);
    for (const prefix of NEXT_PREFIXES) expect(routes, prefix).toContain(prefix);
    expect(routes.filter((r) => !NEXT_PREFIXES.includes(r))).toEqual([]);
  });

  it("passes the new panel routes with their query and refuses look-alikes and non-panel paths", () => {
    expect(safeNext("/kyc")).toBe("/kyc");
    expect(safeNext("/dns/0190aaaa?tab=records")).toBe("/dns/0190aaaa?tab=records");
    expect(safeNext("/static-ips/x")).toBe("/static-ips/x");
    for (const raw of ["/kycx", "/faq", "/payments", "/kyc/../admin", "//kyc", "/%2F%2Fevil.com"]) {
      expect(safeNext(raw), raw).toBeNull();
    }
  });

  it("refuses everything else", () => {
    for (const raw of [
      "//evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "https://evil.com",
      "javascript:x",
      "/wallet/../admin",
      "/wallet/%2e%2e/admin",
      "/%2F%2Fevil.com",
      "/walletx",
      "/wallet\\x",
      "/wallet\r\nSet-Cookie: a=b",
      "/wallet\u0000",
      "wallet",
      "",
      "/",
      "/admin",
      " /wallet",
      "/en/wallet",
    ]) {
      expect(safeNext(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("refuses non-text and very long input", () => {
    for (const raw of [undefined, null, 5, {}, ["/wallet"], true]) {
      expect(safeNext(raw)).toBeNull();
    }
    expect(safeNext(`/wallet?x=${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("assertSameOrigin", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("passes an equal Origin", () => {
    expect(assertSameOrigin(h({ origin: "https://cloud.example.com" }), prod)).toBe(true);
    expect(
      assertSameOrigin(
        h({ origin: "https://cloud.example.com", "sec-fetch-site": "same-origin" }),
        prod,
      ),
    ).toBe(true);
  });

  it("refuses a missing Origin, null, another origin and a lookalike", () => {
    expect(assertSameOrigin(h({}), prod)).toBe(false);
    expect(assertSameOrigin(h({ origin: "null" }), prod)).toBe(false);
    expect(assertSameOrigin(h({ origin: "https://evil.com" }), prod)).toBe(false);
    expect(assertSameOrigin(h({ origin: "https://cloud.example.com.evil.com" }), prod)).toBe(false);
    expect(assertSameOrigin(h({ origin: "http://cloud.example.com" }), prod)).toBe(false);
    expect(assertSameOrigin(h({ origin: "https://cloud.example.com/" }), prod)).toBe(false);
  });

  it("refuses Sec-Fetch-Site: cross-site even with an equal Origin", () => {
    expect(
      assertSameOrigin(
        h({ origin: "https://cloud.example.com", "sec-fetch-site": "cross-site" }),
        prod,
      ),
    ).toBe(false);
  });
});

describe("clientIpOf", () => {
  it("reads the address of the CloudFront viewer header, port removed", () => {
    expect(
      clientIpOf(new Headers({ "cloudfront-viewer-address": "203.0.113.9:44321" }), prod),
    ).toBe("203.0.113.9");
    expect(
      clientIpOf(new Headers({ "cloudfront-viewer-address": "[2001:db8::7]:5000" }), prod),
    ).toBe("2001:db8::7");
  });

  it("never reads x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.1" });
    expect(clientIpOf(headers, prod)).toBeNull();
    expect(clientIpOf(headers, fake)).toBe("127.0.0.1");
    const both = new Headers({
      "x-forwarded-for": "198.51.100.1",
      "cloudfront-viewer-address": "203.0.113.9:1",
    });
    expect(clientIpOf(both, prod)).toBe("203.0.113.9");
  });

  it("an absent header is null outside fake mode and 127.0.0.1 in fake mode", () => {
    expect(clientIpOf(new Headers(), prod)).toBeNull();
    expect(clientIpOf(new Headers(), fake)).toBe("127.0.0.1");
  });

  it("a malformed header is null even in fake mode", () => {
    const headers = new Headers({ "cloudfront-viewer-address": "not-an-address" });
    expect(clientIpOf(headers, prod)).toBeNull();
    expect(clientIpOf(headers, fake)).toBeNull();
  });
});

describe("requestId", () => {
  it("is 8 hex characters and differs between calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => requestId()));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(ids.size).toBeGreaterThan(1);
  });
});
