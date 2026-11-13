// The root sst.config.ts must stay free of static imports (VERIFY result of 2026-11-13). SST 4 bundles the
// config with an esbuild plugin ("DisallowImports", pkg/js/js.go of sst v4.17.2) that refuses every static
// import whose importing file is NAMED sst.config.ts; every command, even `sst secret set`, then fails with
// "Your sst.config.ts has top level imports". The owner hit it on the first `sst secret set`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const config = readFileSync(resolve(root, "sst.config.ts"), "utf8");
// Comments are not code: drop them before looking for statements.
const code = config
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("sst.config.ts", () => {
  it("has no static import and no re-export (SST refuses both before any command runs)", () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s+(\*|\{)[^;]*\bfrom\s/m);
  });

  it("loads the app from infra/app.ts with a dynamic import in both functions", () => {
    expect(code).toMatch(
      /async app\(input\)\s*\{\s*const \{ appConfig \} = await import\("\.\/infra\/app"\);/,
    );
    expect(code).toMatch(
      /async run\(\)\s*\{\s*const \{ runApp \} = await import\("\.\/infra\/app"\);/,
    );
    expect(code).toContain('return appConfig(input?.stage ?? "", process.env);');
    expect(code).toContain("return runApp(process.env);");
  });

  it("is the only tracked file named sst.config.ts (the SST rule matches the file name)", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => basename(f) === "sst.config.ts");
    expect(tracked).toEqual(["sst.config.ts"]);
  });
});

describe("infra/app.ts", () => {
  const app = readFileSync(resolve(root, "infra/app.ts"), "utf8");

  it("exports the two functions the root config calls, and no $config of its own", () => {
    expect(app).toMatch(/export function appConfig\(stage: string, env: Env\)/);
    expect(app).toMatch(/export async function runApp\(env: Env\)/);
    expect(app).not.toContain("$config(");
  });

  it("keeps the production guard in the app part (it runs for every command, secrets included)", () => {
    expect(app).toMatch(
      /export function appConfig\([^)]*\) \{\s*\/\/[^\n]*\n\s*assertDeployAllowed\(stage, env\);/,
    );
  });
});
