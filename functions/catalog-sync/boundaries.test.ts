import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function sources(): { name: string; text: string }[] {
  return readdirSync(here, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts"),
    )
    .map((e) => ({ name: e.name, text: readFileSync(join(here, e.name), "utf8") }));
}

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

describe("catalog-sync boundaries", () => {
  const files = sources();

  it("sees the production files", () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["handler.ts", "config.ts", "deps.ts", "index.ts"]),
    );
  });

  it("imports only @tc/aws, @tc/core, @tc/db, node built-ins and its own files", () => {
    for (const f of files) {
      const specs = [
        ...f.text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
        ...f.text.matchAll(/require\(\s*["']([^"']+)["']/g),
      ].map((m) => m[1]!);
      for (const s of specs) {
        const ok =
          s.startsWith("./") || ["@tc/aws", "@tc/core", "@tc/db"].includes(s) || BUILTIN.has(s);
        expect(ok, `${f.name}: ${s}`).toBe(true);
      }
    }
  });

  it("reaches the SDK only through @tc/aws (R1)", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toContain("@aws-sdk");
      expect(f.text, f.name).not.toContain("aws-sdk");
    }
  });

  it("reads process.env only in index.ts, only to hand it to readConfig (R3)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("process.env");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    const uses = index.match(/[^\n]*process\.env[^\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/readConfig\(process\.env\)/);
    expect(index).not.toMatch(/process\.env\./);
    expect(index).not.toMatch(/process\.env\[/);
  });

  it("uses console only in index.ts (R14)", () => {
    for (const f of files.filter((x) => x.name !== "index.ts")) {
      expect(f.text, f.name).not.toContain("console.");
    }
    const index = files.find((f) => f.name === "index.ts")!.text;
    expect(index.match(/console\./g) ?? []).toHaveLength(1);
  });

  it("does no float or lossy number work near money (R4)", () => {
    for (const f of files) {
      for (const bad of ["Number(", "parseFloat(", "toFixed"]) {
        expect(f.text, `${f.name} ${bad}`).not.toContain(bad);
      }
    }
  });

  it("does not use sst, and never runs sst secret", () => {
    for (const f of files) {
      expect(f.text, f.name).not.toMatch(/from\s+["']sst["']/);
      expect(f.text, f.name).not.toMatch(/import\(\s*["']sst["']/);
      expect(f.text, f.name).not.toContain("sst secret");
    }
  });

  it("depends on exactly the three workspace links (R17)", () => {
    const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({
      "@tc/aws": "workspace:*",
      "@tc/core": "workspace:*",
      "@tc/db": "workspace:*",
    });
  });
});
