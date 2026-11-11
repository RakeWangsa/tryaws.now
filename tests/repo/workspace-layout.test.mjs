import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

const packages = {
  "apps/web": "@tc/web",
  "apps/admin": "@tc/admin",
  "packages/core": "@tc/core",
  "packages/db": "@tc/db",
  "packages/aws": "@tc/aws",
  "packages/eps": "@tc/eps",
  "packages/notify": "@tc/notify",
  "packages/auth": "@tc/auth",
  "packages/ui": "@tc/ui",
  "functions/provisioner": "@tc/fn-provisioner",
  "functions/reader": "@tc/fn-reader",
  "functions/access-details": "@tc/fn-access-details",
  "functions/scheduler": "@tc/fn-scheduler",
  "functions/payments-sweeper": "@tc/fn-payments-sweeper",
  "functions/catalog-sync": "@tc/fn-catalog-sync",
  "functions/reconciler": "@tc/fn-reconciler",
  "functions/migrator": "@tc/fn-migrator",
  "functions/invoice-renderer": "@tc/fn-invoice-renderer",
  "functions/notifier": "@tc/fn-notifier",
  "functions/cognito-messages": "@tc/fn-cognito-messages",
};

// The shared form of a package's tsconfig.json (kit plan, Task 7). A package that needs more, for
// example "jsx" in a Next.js app, gets its difference here, so that it is reviewed with this file.
const tsconfigExtras = {
  "packages/ui": {
    compilerOptions: {
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      jsx: "react-jsx",
      resolveJsonModule: true,
      types: ["node"],
    },
  },
  // Next.js rewrites the tsconfig of an app on `next dev` and `next build`; what it adds is pinned
  // here (WPU-T4). The app program loads the raw .ts sources of @tc/ui, so it allows the extension.
  "apps/web": {
    compilerOptions: { allowImportingTsExtensions: true, jsx: "react-jsx" },
  },
  "apps/admin": {
    compilerOptions: { allowImportingTsExtensions: true, jsx: "react-jsx" },
  },
};

// @tc/db also publishes its test helpers to the test files of other packages (WP1-T2).
const EXPORTS = {
  "packages/db": { ".": "./index.ts", "./testing": "./testing/index.ts" },
  "packages/auth": { ".": "./index.ts", "./testing": "./testing/index.ts" },
  // @tc/ui also publishes the theme facts for the root layouts of both apps (WPU-T1).
  "packages/ui": {
    ".": "./index.ts",
    "./theme": "./theme/public.ts",
    "./runtime": "./runtime/index.ts",
    "./messages": "./messages/index.ts",
    "./gallery": "./gallery/index.ts",
  },
};

it.each(Object.entries(packages))("%s is the private workspace package %s", (dir, name) => {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  expect(pkg.name).toBe(name);
  expect(pkg.private).toBe(true);
  expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
  expect(existsSync(`${dir}/index.ts`), `${dir}/index.ts`).toBe(true);
  expect(existsSync(`${dir}/src`), `${dir}/src`).toBe(false);
  expect(pkg.exports).toEqual(EXPORTS[dir] ?? { ".": "./index.ts" });
  for (const target of Object.values(pkg.exports))
    expect(existsSync(`${dir}/${target}`), `${dir}/${target}`).toBe(true);
  expect(JSON.parse(readFileSync(`${dir}/tsconfig.json`, "utf8")), `${dir}/tsconfig.json`).toEqual({
    extends: "../../tsconfig.base.json",
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules", "dist", ".next", ".sst"],
    ...tsconfigExtras[dir],
  });
});

it("every workspace package on disk is in the table above, and every row is on disk", () => {
  const found = Object.keys(readWorkspacePackages("."));
  const listed = Object.keys(packages);
  const problems = [
    ...found
      .filter((dir) => !listed.includes(dir))
      .map(
        (dir) =>
          `${dir}: add it to the table of tests/repo/workspace-layout.test.mjs (spec section 5), with a typecheck script`,
      ),
    ...listed
      .filter((dir) => !found.includes(dir))
      .map((dir) => `${dir}: in the table but not a workspace package on disk`),
  ];
  expect(problems).toEqual([]);
});

it("the pricing engine is where the spec and the money rule file name it", () => {
  for (const file of [
    "packages/core/types.ts",
    "packages/core/pricing/quote.ts",
    "packages/core/pricing/index.ts",
  ]) {
    expect(existsSync(file), file).toBe(true);
  }
});

it("has the other folders of spec section 5", () => {
  for (const dir of [
    "infra/org",
    "tests/repo",
    "design/mockup/template",
    "design/brand",
    "design/reference",
    "scripts/lib",
    "verify",
    "content",
    "docs/runbooks",
  ]) {
    expect(existsSync(dir), dir).toBe(true);
  }
});

it("no longer has mockup/ at the root", () => {
  expect(existsSync("mockup")).toBe(false);
});

// The places of workspace packages are named twice: WORKSPACE_FOLDERS (scripts/lib/changed-packages.mjs,
// which --quick and the graph test read) and the globs of pnpm-workspace.yaml (which pnpm installs).
// They must be the same three folders, so that no package is installed that the checks never read.
it("WORKSPACE_FOLDERS and the globs of pnpm-workspace.yaml name the same folders", () => {
  const source = readFileSync("scripts/lib/changed-packages.mjs", "utf8");
  const folders = /const WORKSPACE_FOLDERS = (\[[^\]]*\]);/.exec(source)?.[1];
  expect(folders).toBeDefined();
  expect(JSON.parse(folders)).toEqual(["apps", "packages", "functions"]);
  expect(parse(readFileSync("pnpm-workspace.yaml", "utf8")).packages).toEqual([
    "apps/*",
    "packages/*",
    "functions/*",
  ]);
});

it("runs on the Node version pinned in .nvmrc", () => {
  const pinned = readFileSync(".nvmrc", "utf8").trim();
  expect(pinned).toMatch(/^24\.\d+\.\d+$/);
  expect(process.versions.node).toBe(pinned);
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  expect(root.engines.node).toBe(">=24 <25");
  expect(root.packageManager).toMatch(/^pnpm@10\./);
});
