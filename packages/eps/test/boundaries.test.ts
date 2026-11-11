import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const sources = readdirSync(ROOT)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(ROOT, f), "utf8") }));

// Comments may name what is forbidden ("no process.env"); only code is searched. A "//" that follows a
// colon belongs to a URL, so only a "//" at the start of a line or after a space opens a comment.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function offenders(pattern: RegExp, skip: (file: string) => boolean = () => false): string[] {
  return sources
    .filter((s) => !skip(s.file))
    .filter((s) => pattern.test(code(s.text)))
    .map((s) => s.file);
}

describe("boundaries of packages/eps", () => {
  it("reads the package files (not an empty list)", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["index.ts", "service.ts", "verify.ts", "http.ts"]),
    );
  });

  it("imports no AWS package (R1, R3)", () => {
    expect(offenders(/from\s+["'](@tc\/aws|aws-sdk|@aws-sdk\/[^"']*)["']/)).toEqual([]);
    expect(offenders(/require\(\s*["'](@tc\/aws|aws-sdk|@aws-sdk\/)/)).toEqual([]);
  });

  it("reads no environment (credentials are a parameter), except the guard of the fake", () => {
    const hits = sources.filter((s) => {
      const text = code(s.text);
      const stripped = s.file === "fake.ts" ? text.replace(/process\.env\.NODE_ENV/g, "") : text;
      return /process\.env|import\.meta\.env/.test(stripped);
    });
    expect(hits.map((s) => s.file)).toEqual([]);
  });

  it("uses no float or number conversion near money (R4)", () => {
    expect(offenders(/\bNumber\s*\(/)).toEqual([]);
    expect(offenders(/\bparseFloat\b/)).toEqual([]);
    expect(offenders(/\bparseInt\b/)).toEqual([]);
    expect(offenders(/\btoFixed\b/)).toEqual([]);
    expect(offenders(/\bMath\.round\b/)).toEqual([]);
  });

  it("logs only through safeLog", () => {
    expect(offenders(/\bconsole\s*\./)).toEqual([]);
  });

  it("never updates or deletes ledger rows (R5)", () => {
    expect(offenders(/\b(update|delete)\b[^;`"']{0,40}\bledger_/i)).toEqual([]);
    expect(offenders(/ledger_[a-z_]*["'`]?\s*\)?\s*\.\s*(update|delete)\b/i)).toEqual([]);
  });

  it("interpolates no key, password or token into a template string outside http.ts (R14)", () => {
    expect(
      offenders(/\$\{[^}]*\b(hashKey|password|token)\b[^}]*\}/i, (f) => f === "http.ts"),
    ).toEqual([]);
  });

  it("calls fetch only in http.ts", () => {
    expect(offenders(/\bfetch\b/, (f) => f === "http.ts")).toEqual([]);
  });
});
