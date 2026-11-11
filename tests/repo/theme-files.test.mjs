import { spawnSync } from "node:child_process";
import * as prettier from "prettier";
import { expect, it } from "vitest";

const ignoredByPrettier = async (file) =>
  (await prettier.getFileInfo(file, { ignorePath: ".prettierignore" })).ignored;
const ignoredByGit = (file) =>
  spawnSync("git", ["check-ignore", "--quiet", "--no-index", file]).status === 0;

it("prettier leaves the vendored theme alone but formats tc.css and the code (WPU-T1)", async () => {
  for (const file of [
    "packages/ui/theme/assets/css/theme.min.css",
    "packages/ui/theme/assets/fonts/fonts.min.css",
    "packages/ui/theme/assets/apps/ubuntu.svg",
  ]) {
    expect(await ignoredByPrettier(file), file).toBe(true);
  }
  for (const file of [
    "packages/ui/styles/tc.css",
    "packages/ui/theme/tree.ts",
    "scripts/sync-theme.ts",
  ]) {
    expect(await ignoredByPrettier(file), file).toBe(false);
  }
});

it("git keeps the vendored theme and tc.css (they are committed)", () => {
  for (const file of [
    "packages/ui/theme/assets/css/theme.min.css",
    "packages/ui/theme/assets/fonts/cloudicon/Cloudicon.woff",
    "packages/ui/theme/script-hashes.txt",
    "packages/ui/styles/tc.css",
  ]) {
    expect(ignoredByGit(file), file).toBe(false);
  }
});

it("prettier and git leave the generated public/theme of both apps alone (WPU-T1)", async () => {
  for (const file of [
    "apps/web/public/theme/tc.css",
    "apps/web/public/theme/assets/css/theme.min.css",
    "apps/admin/public/theme/assets/fonts/fonts.min.css",
  ]) {
    expect(await ignoredByPrettier(file), file).toBe(true);
    expect(ignoredByGit(file), file).toBe(true);
  }
});

it("the ignore patterns for public/theme are narrow: other files of public/ and the apps stay visible", async () => {
  for (const file of [
    "apps/web/public/favicon.ico",
    "apps/web/package.json",
    "apps/admin/public/robots.txt",
  ]) {
    expect(ignoredByGit(file), file).toBe(false);
  }
  expect(await ignoredByPrettier("apps/web/public/robots.txt")).toBe(false);
});
