import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import * as prettier from "prettier";
import { expect, it } from "vitest";

it("prettier leaves the plans, the mockup and the generated or verbatim files alone", async () => {
  for (const file of [
    "TICON_CLOUD_MEGA_PLAN.md",
    "TiCON Cloud Lightsail প্ল্যাটফর্ম ৭ দিনের লঞ্চ প্ল্যান.md",
    "design/mockup/changelog(4.5.0).rtf",
    "docs/spec/INDEX.md",
    "docs/audit/2026-11-11-mega-plan-audit.md",
    "docs/superpowers/plans/2026-11-11-wp0-t1-repository-kit.md",
    "CLAUDE.md",
    ".claude/rules/money.md",
    ".github/pull_request_template.md",
    "pnpm-lock.yaml",
    "verify/baseline.json",
    "packages/db/migrations/meta/_journal.json",
  ]) {
    const info = await prettier.getFileInfo(file, { ignorePath: ".prettierignore" });
    expect(info.ignored, file).toBe(true);
  }
});

it("eslint ignores design/, docs/ and .claude/", async () => {
  const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });
  for (const file of [
    "design/mockup/template/assets/js/scripts.js",
    "docs/spec/INDEX.md",
    ".claude/hooks/x.js",
  ]) {
    expect(await eslint.isPathIgnored(file), file).toBe(true);
  }
});

it("eslint ignores build output and local tool folders, but not source files", async () => {
  const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });
  for (const file of [
    "apps/web/.next/server/chunk.js",
    "apps/web/.open-next/x.mjs",
    ".sst/platform/x.ts",
    ".superpowers/sdd/x.mjs",
    ".remember/x.mjs",
  ]) {
    expect(await eslint.isPathIgnored(file), file).toBe(true);
  }
  expect(await eslint.isPathIgnored("apps/web/page.tsx")).toBe(false);
});

it("git ignores the build output of Next.js and OpenNext, but not source files", () => {
  const ignored = (file) =>
    spawnSync("git", ["check-ignore", "--quiet", "--no-index", file]).status === 0;
  for (const file of ["apps/web/.next/x.js", "apps/web/.open-next/x.js"]) {
    expect(ignored(file), file).toBe(true);
  }
  expect(ignored("apps/web/page.tsx")).toBe(false);
});
