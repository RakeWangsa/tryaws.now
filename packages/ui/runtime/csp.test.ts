import { describe, expect, it } from "vitest";
import {
  CSP_ENFORCED_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_PATH,
  buildCsp,
  createNonce,
} from "./csp.ts";

function directive(csp: string, name: string): string {
  const found = csp.split("; ").find((d) => d === name || d.startsWith(`${name} `));
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

describe("constants", () => {
  it("names the headers and the report path", () => {
    expect(CSP_REPORT_ONLY_HEADER).toBe("Content-Security-Policy-Report-Only");
    expect(CSP_ENFORCED_HEADER).toBe("Content-Security-Policy");
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });
});

describe("createNonce", () => {
  it("is 24 base64 characters", () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("two nonces differ", () => {
    expect(createNonce()).not.toBe(createNonce());
  });

  it("with zero bytes is AAAAAAAAAAAAAAAAAAAAAA==", () => {
    expect(createNonce((n) => new Uint8Array(n))).toBe("AAAAAAAAAAAAAAAAAAAAAA==");
  });

  it("asks for 16 bytes", () => {
    let asked = 0;
    createNonce((n) => {
      asked = n;
      return new Uint8Array(n);
    });
    expect(asked).toBe(16);
  });
});

describe("buildCsp", () => {
  it("script-src holds the nonce and strict-dynamic and never unsafe-inline", () => {
    for (const dev of [false, true]) {
      const script = directive(buildCsp({ nonce: "AAAA", dev }), "script-src");
      expect(script).toContain("'self'");
      expect(script).toContain("'nonce-AAAA'");
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
    }
  });

  it("dev adds unsafe-eval and ws:, production adds upgrade-insecure-requests", () => {
    const dev = buildCsp({ nonce: "AAAA", dev: true });
    const prod = buildCsp({ nonce: "AAAA", dev: false });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toBe("connect-src 'self' ws: wss:");
    expect(directive(dev, "style-src")).toContain("'unsafe-inline'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("ws:");
    expect(prod).not.toContain("'unsafe-inline'");
    expect(directive(prod, "upgrade-insecure-requests")).toBe("upgrade-insecure-requests");
  });

  it("frame-ancestors is none and object-src is none", () => {
    const csp = buildCsp({ nonce: "AAAA", dev: false });
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
  });

  it("report-uri and report-to are present", () => {
    const csp = buildCsp({ nonce: "AAAA", dev: false });
    expect(directive(csp, "report-uri")).toBe("report-uri /api/csp-report");
    expect(directive(csp, "report-to")).toBe("report-to csp");
  });

  it.each(["a b", "'x'", ";", "", "a;b"])("a bad nonce %j throws RangeError", (nonce) => {
    expect(() => buildCsp({ nonce, dev: false })).toThrow(RangeError);
  });

  it("accepts a real nonce", () => {
    expect(() => buildCsp({ nonce: createNonce(), dev: false })).not.toThrow();
  });

  it("directive order is stable", () => {
    expect(buildCsp({ nonce: "AAAA", dev: false })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-AAAA' 'strict-dynamic'",
        "style-src 'self' 'nonce-AAAA'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
        "report-uri /api/csp-report",
        "report-to csp",
      ].join("; "),
    );
  });

  it("directive order in dev is stable", () => {
    expect(buildCsp({ nonce: "AAAA", dev: true })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-AAAA' 'strict-dynamic' 'unsafe-eval'",
        "style-src 'self' 'nonce-AAAA' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "report-uri /api/csp-report",
        "report-to csp",
      ].join("; "),
    );
  });
});

describe("buildCsp: formActionOrigins", () => {
  it("no argument, undefined and an empty list keep form-action 'self'", () => {
    const plain = buildCsp({ nonce: "AAAA", dev: false });
    expect(directive(plain, "form-action")).toBe("form-action 'self'");
    expect(buildCsp({ nonce: "AAAA", dev: false, formActionOrigins: undefined })).toBe(plain);
    expect(buildCsp({ nonce: "AAAA", dev: false, formActionOrigins: [] })).toBe(plain);
  });

  it("adds the origins after 'self', in order, and changes no other directive", () => {
    const plain = buildCsp({ nonce: "AAAA", dev: false });
    const csp = buildCsp({
      nonce: "AAAA",
      dev: false,
      formActionOrigins: ["https://pg.eps.com.bd", "https://other.example:8443"],
    });
    expect(directive(csp, "form-action")).toBe(
      "form-action 'self' https://pg.eps.com.bd https://other.example:8443",
    );
    expect(csp.replace(/form-action [^;]*/, "form-action 'self'")).toBe(plain);
  });

  it("keeps the directive in the same place", () => {
    const csp = buildCsp({
      nonce: "AAAA",
      dev: true,
      formActionOrigins: ["https://pg.eps.com.bd"],
    });
    const names = csp.split("; ").map((d) => d.split(" ")[0]);
    expect(names.indexOf("form-action")).toBe(names.indexOf("base-uri") + 1);
  });

  it.each([
    "https://pg.eps.com.bd/path",
    "https://pg.eps.com.bd/",
    "https://pg.eps.com.bd'",
    "https://pg.eps com.bd",
    "https://pg.eps.com.bd; script-src *",
    "http://pg.eps.com.bd",
    "https://*.eps.com.bd",
    "'self'",
    "*",
    "pg.eps.com.bd",
    "https://",
    "https://pg.eps.com.bd?x=1",
    "https://user@pg.eps.com.bd",
    "",
  ])("the origin %j throws RangeError", (origin) => {
    expect(() => buildCsp({ nonce: "AAAA", dev: false, formActionOrigins: [origin] })).toThrow(
      RangeError,
    );
  });
});
