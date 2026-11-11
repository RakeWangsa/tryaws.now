// Parser of CSP violation reports for `/api/csp-report` (U4, R14). The endpoint is anonymous, so
// everything here validates and caps its input and never throws. Nothing but origin and path
// of a URL is kept: no credentials, no query string, no fragment (R3, R14).

export interface CspViolation {
  directive: string;
  blocked: string;
  documentPath: string;
  source: string | null;
  line: number | null;
  disposition: "report" | "enforce" | "unknown";
}

const MAX_TEXT = 200;
const MAX_REPORTS = 10;
const MAX_SCANNED = 100;
const KEYWORDS = new Set(["inline", "eval", "data", "blob", "self", "wasm-eval"]);

function cut(text: string): string {
  return text.slice(0, MAX_TEXT);
}

export function sanitizeUri(uri: unknown): string {
  if (typeof uri !== "string") return "unknown";
  const lower = uri.toLowerCase();
  if (KEYWORDS.has(lower)) return lower;
  if (lower.startsWith("data:")) return "data";
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    return cut(url.origin + url.pathname);
  } catch {
    return "unknown";
  }
}

function documentPathOf(uri: unknown): string {
  if (typeof uri !== "string") return "unknown";
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    return cut(url.pathname);
  } catch {
    return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only the directive name: a legacy `violated-directive` can hold the whole policy text.
function directiveOf(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const name = value.trim().split(/\s+/)[0] ?? "";
  return name === "" ? "unknown" : cut(name);
}

function sourceOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? sanitizeUri(value) : null;
}

function lineOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function dispositionOf(value: unknown): CspViolation["disposition"] {
  return value === "report" || value === "enforce" ? value : "unknown";
}

function fromLegacy(report: Record<string, unknown>): CspViolation {
  return {
    directive: directiveOf(report["effective-directive"] ?? report["violated-directive"]),
    blocked: sanitizeUri(report["blocked-uri"]),
    documentPath: documentPathOf(report["document-uri"]),
    source: sourceOf(report["source-file"]),
    line: lineOf(report["line-number"]),
    disposition: dispositionOf(report["disposition"]),
  };
}

function fromModern(body: Record<string, unknown>): CspViolation {
  return {
    directive: directiveOf(body["effectiveDirective"]),
    blocked: sanitizeUri(body["blockedURL"]),
    documentPath: documentPathOf(body["documentURL"]),
    source: sourceOf(body["sourceFile"]),
    line: lineOf(body["lineNumber"]),
    disposition: dispositionOf(body["disposition"]),
  };
}

export function parseCspReports(contentType: string | null, body: unknown): CspViolation[] {
  try {
    const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (type === "application/csp-report") {
      if (!isRecord(body)) return [];
      const report = body["csp-report"];
      return isRecord(report) ? [fromLegacy(report)] : [];
    }
    if (type === "application/reports+json") {
      if (!Array.isArray(body)) return [];
      const found: CspViolation[] = [];
      for (const entry of body.slice(0, MAX_SCANNED)) {
        if (found.length >= MAX_REPORTS) break;
        if (isRecord(entry) && entry["type"] === "csp-violation" && isRecord(entry["body"])) {
          found.push(fromModern(entry["body"]));
        }
      }
      return found;
    }
    return [];
  } catch {
    return [];
  }
}

export function violationLogLine(app: "web" | "admin", v: CspViolation): string {
  return JSON.stringify({
    level: "warn",
    event: "csp.violation",
    app,
    directive: cut(v.directive),
    blocked: sanitizeUri(v.blocked),
    documentPath: cut(v.documentPath.split(/[?#]/)[0] ?? ""),
    source: v.source === null ? null : sanitizeUri(v.source),
    line: v.line,
    disposition: v.disposition,
  });
}
