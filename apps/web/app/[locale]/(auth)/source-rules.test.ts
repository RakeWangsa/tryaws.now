import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// R1, R3, R8: the pages and forms of the sign-in screens call no provisioning code, no database and no
// environment. They reach data only through the server modules of apps/web (server/auth-page.ts,
// server/phone-step.ts, the Server Actions), which are the places that follow R8 and R9.
const here = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("files under app/[locale]/(auth)", () => {
  const files = walk(here).filter((f) => !f.endsWith("page-harness.tsx"));

  it("sees the five screens", () => {
    expect(files.filter((f) => f.endsWith("/page.tsx"))).toHaveLength(5);
  });

  it("import no @tc/aws, no AWS SDK and no @tc/db", () => {
    for (const file of files) {
      const imports = [...strip(readFileSync(file, "utf8")).matchAll(IMPORT)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, file).not.toMatch(/^@tc\/(?:aws|db)(?:\/|$)/);
        expect(specifier, file).not.toMatch(/^@(?:aws-sdk|smithy)\//);
      }
    }
  });

  it("read no environment variable and print nothing to the console", () => {
    for (const file of files) {
      const text = strip(readFileSync(file, "utf8"));
      expect(/\bprocess\s*\.\s*env\b/.test(text), `${file} env`).toBe(false);
      expect(/\bconsole\s*\./.test(text), `${file} console`).toBe(false);
    }
  });

  it("have no inline style, no inline script and no hard-coded URL of another host", () => {
    for (const file of files) {
      const text = strip(readFileSync(file, "utf8"));
      expect(/\sstyle\s*=/.test(text), `${file} style`).toBe(false);
      expect(/<script/i.test(text), `${file} script`).toBe(false);
      expect(/https?:\/\//.test(text), `${file} url`).toBe(false);
    }
  });

  it("every Server Action file starts with the use-server directive and exports async functions only", () => {
    for (const file of files.filter((f) => f.endsWith("/actions.ts"))) {
      const text = readFileSync(file, "utf8");
      expect(text.startsWith('"use server";'), file).toBe(true);
      const exports = [...text.matchAll(/^export\s+(\w+)\s+(\w+)/gm)];
      expect(exports.length, file).toBeGreaterThan(0);
      for (const found of exports) {
        expect(found[1], `${file} ${found[2]}`).toBe("async");
      }
    }
  });
});
