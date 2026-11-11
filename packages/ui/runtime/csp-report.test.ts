import { describe, expect, it } from "vitest";
import { parseCspReports, sanitizeUri, violationLogLine } from "./csp-report.ts";

const legacy = {
  "csp-report": {
    "document-uri": "https://cloud.example/en/wallet?x=1",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.example/a.js?k=1",
    "source-file": "https://cloud.example/_next/x.js",
    "line-number": 7,
    disposition: "report",
  },
};

// The legacy report without `effective-directive`, so that `violated-directive` is the one read.
const onlyViolated = {
  "document-uri": "https://cloud.example/wallet",
  "blocked-uri": "inline",
};

const modern = [
  {
    type: "csp-violation",
    url: "https://cloud.example/wallet",
    body: {
      documentURL: "https://cloud.example/wallet?q=1",
      effectiveDirective: "style-src-attr",
      blockedURL: "inline",
      sourceFile: null,
      lineNumber: null,
      disposition: "enforce",
    },
  },
  { type: "deprecation", body: {} },
];

describe("parseCspReports", () => {
  it("report-uri shape is parsed", () => {
    expect(parseCspReports("application/csp-report", legacy)).toEqual([
      {
        directive: "script-src-elem",
        blocked: "https://evil.example/a.js",
        documentPath: "/en/wallet",
        source: "https://cloud.example/_next/x.js",
        line: 7,
        disposition: "report",
      },
    ]);
  });

  it("report-to array is parsed", () => {
    expect(parseCspReports("application/reports+json", modern)).toEqual([
      {
        directive: "style-src-attr",
        blocked: "inline",
        documentPath: "/wallet",
        source: null,
        line: null,
        disposition: "enforce",
      },
    ]);
  });

  it("content type may carry parameters and any case", () => {
    expect(parseCspReports("Application/CSP-Report; charset=utf-8", legacy)).toHaveLength(1);
  });

  it("more than 10 reports gives 10", () => {
    const many = Array.from({ length: 25 }, () => modern[0]);
    expect(parseCspReports("application/reports+json", many)).toHaveLength(10);
  });

  it.each([null, "x", 42, {}, [1], undefined, [null], { "csp-report": 5 }])(
    "garbage %j gives []",
    (body) => {
      expect(parseCspReports("application/csp-report", body)).toEqual([]);
      expect(parseCspReports("application/reports+json", body)).toEqual([]);
      expect(parseCspReports(null, body)).toEqual([]);
    },
  );

  it("an unknown content type gives []", () => {
    expect(parseCspReports("text/plain", legacy)).toEqual([]);
    expect(parseCspReports("application/json", modern)).toEqual([]);
  });

  it("an unknown disposition becomes unknown and a bad line becomes null", () => {
    const [v] = parseCspReports("application/csp-report", {
      "csp-report": { ...legacy["csp-report"], disposition: "weird", "line-number": "7" },
    });
    expect(v?.disposition).toBe("unknown");
    expect(v?.line).toBeNull();
  });

  it("cuts the directive to 200 characters", () => {
    const [v] = parseCspReports("application/csp-report", {
      "csp-report": { ...onlyViolated, "violated-directive": "d".repeat(500) },
    });
    expect(v?.directive.length).toBe(200);
  });

  it("keeps only the directive name of a full violated-directive", () => {
    const [v] = parseCspReports("application/csp-report", {
      "csp-report": { ...onlyViolated, "violated-directive": "script-src 'self' 'nonce-SECRET'" },
    });
    expect(v?.directive).toBe("script-src");
  });
});

describe("sanitizeUri", () => {
  it("removes query and fragment from every URI", () => {
    expect(sanitizeUri("https://x.example/p?token=abc#frag")).toBe("https://x.example/p");
  });

  it("removes credentials", () => {
    expect(sanitizeUri("https://user:pw@x.example/p")).toBe("https://x.example/p");
  });

  it("keeps the port in the origin", () => {
    expect(sanitizeUri("http://localhost:3000/a?b=1")).toBe("http://localhost:3000/a");
  });

  it.each(["inline", "eval", "data", "blob", "self", "wasm-eval"])("keyword %s stays", (kw) => {
    expect(sanitizeUri(kw)).toBe(kw);
  });

  it("keywords in any case are returned in lower case", () => {
    expect(sanitizeUri("INLINE")).toBe("inline");
    expect(sanitizeUri("Eval")).toBe("eval");
  });

  it("a data: URI becomes data", () => {
    expect(sanitizeUri("data:image/png;base64,AAAA")).toBe("data");
    expect(sanitizeUri("DATA:text/plain,hi")).toBe("data");
  });

  it("strings are cut to 200", () => {
    const out = sanitizeUri(`https://x.example/${"a".repeat(500)}`);
    expect(out.length).toBe(200);
  });

  it.each([undefined, null, 42, {}, "not a url", "ftp://x.example/a", "javascript:alert(1)", ""])(
    "%j becomes unknown",
    (value) => {
      expect(sanitizeUri(value)).toBe("unknown");
    },
  );
});

describe("violationLogLine", () => {
  it("is valid JSON and holds no query string", () => {
    const [v] = parseCspReports("application/csp-report", legacy);
    if (v === undefined) throw new Error("no violation");
    const line = violationLogLine("web", v);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("?");
    expect(line).not.toContain("#");
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toEqual({
      level: "warn",
      event: "csp.violation",
      app: "web",
      directive: "script-src-elem",
      blocked: "https://evil.example/a.js",
      documentPath: "/en/wallet",
      source: "https://cloud.example/_next/x.js",
      line: 7,
      disposition: "report",
    });
  });
});
