import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { childEnv } from "./child-env.mjs";

// WPU-B4 (audit item 38): type-check the SST stack files (infra/stacks, infra/app.ts and the root sst.config.ts).
// They use the globals of SST ($config, $app, sst.aws.*), which exist only after `sst install` has
// generated .sst/platform/config.d.ts, and that command downloads Pulumi and the AWS provider: it needs
// network. Without that file this check is SKIPPED with the reason below (never a pass of the types).
// WPU-Z9: with the SST 4.17.2 platform present the check runs and passes. The node types come
// from the root devDependency @types/node. The program also compiles SST's own sources, which do
// not build with noUncheckedIndexedAccess: the stacks tsconfig turns that flag off, nothing else.
//
// For a person with network, once:
//   pnpm install --frozen-lockfile
//   pnpm exec sst install          # writes .sst/platform/config.d.ts; no AWS credentials, no deploy
//   node node_modules/typescript/bin/tsc -p infra/tsconfig.stacks.json
//   pnpm test --filter repo sst-types      # runs the same tsc call as this test
const root = resolve(import.meta.dirname, "../..");
const platformTypes = resolve(root, ".sst/platform/config.d.ts");
const SKIP_REASON =
  "SST types are not generated here: run `pnpm exec sst install` (needs network, no AWS credentials) " +
  "and then `pnpm exec tsc -p infra/tsconfig.stacks.json`";

// A tsconfig may hold comments: read it the way tsc does.
function tsconfig(file) {
  const { config, error } = ts.readConfigFile(resolve(root, file), ts.sys.readFile);
  expect(error, file).toBeUndefined();
  return config;
}

describe("infra/tsconfig.stacks.json", () => {
  const config = tsconfig("infra/tsconfig.stacks.json");

  it("covers the stack files, the SST config and the generated SST types", () => {
    expect(config.include).toEqual(
      expect.arrayContaining([
        "app.ts",
        "../sst.config.ts",
        "stacks/**/*.ts",
        "../.sst/platform/config.d.ts",
      ]),
    );
    expect(config.extends).toBe("../tsconfig.base.json");
  });

  it("relaxes only noUncheckedIndexedAccess, the one option SST's own sources need off (WPU-Z9)", () => {
    expect(config.compilerOptions).toEqual({ types: ["node"], noUncheckedIndexedAccess: false });
  });

  it("is not part of the ordinary typecheck, which stays offline (the lib part is checked by infra/tsconfig.json)", () => {
    const ordinary = tsconfig("infra/tsconfig.json");
    expect(ordinary.include).toEqual(["lib/**/*.ts"]);
    // infra/lib keeps every option of the base, noUncheckedIndexedAccess included
    expect(ordinary.compilerOptions).toBeUndefined();
    expect(tsconfig("tsconfig.base.json").compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  it("finds the node types in a pinned root devDependency, the version the workspace already uses (WPU-Z9, R17)", () => {
    const typesNode = (dir) =>
      JSON.parse(readFileSync(resolve(root, dir, "package.json"), "utf8")).devDependencies[
        "@types/node"
      ];
    expect(typesNode(".")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typesNode(".")).toBe(typesNode("packages/aws"));
  });
});

function tscStacks(...args) {
  const tsc = resolve(root, "node_modules/typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", "infra/tsconfig.stacks.json", ...args], {
    cwd: root,
    encoding: "utf8",
    env: childEnv(),
  });
  return { output: run.stdout + run.stderr, status: run.status };
}

const withPlatform = it.skipIf(!existsSync(platformTypes));

withPlatform(
  `the SST stack files type-check (skipped when the SST types are missing: ${SKIP_REASON})`,
  () => {
    const run = tscStacks();
    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  },
  180_000,
);

// The relaxation is for SST's sources, never for ours: with the flag back on, every error is in
// .sst/platform. Our stack code stays checked for an undefined lookup (WPU-Z9 found the
// catalog-sync grant that way).
withPlatform(
  "needs noUncheckedIndexedAccess off for SST's own sources only (WPU-Z9, skipped like the check above)",
  () => {
    const run = tscStacks("--noUncheckedIndexedAccess", "true", "--pretty", "false");
    const files = [...run.output.matchAll(/^(\S[^\n(]*)\(\d+,\d+\): error TS\d+/gm)].map(
      (m) => m[1],
    );
    expect(files).toHaveLength((run.output.match(/error TS\d+:/g) ?? []).length);
    // When SST's sources build with the flag, this fails: then remove the relaxation.
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !file.startsWith(".sst/platform/"))).toEqual([]);
  },
  180_000,
);
