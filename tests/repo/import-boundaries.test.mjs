import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { expect, it } from "vitest";
import { childEnv } from "./child-env.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function listTracked(paths) {
  const result = spawnSync("git", ["ls-files", "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv(),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

const eslint = new ESLint();
async function errors(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.severity === 2).map((m) => m.message);
}

it.each([
  ["apps/web/x.ts", 'import "@tc/aws";', "R1:"],
  ["apps/admin/x.ts", 'import "@tc/aws/adapters/linux";', "R1:"],
  ["apps/web/x.ts", 'import "../../packages/aws/index";', "R1:"],
  ["packages/db/x.ts", 'import "@tc/aws";', "R1:"],
  ["apps/web/x.ts", 'import "@aws-sdk/client-lightsail";', "Spec section 4:"],
  ["functions/reader/x.ts", 'import "@aws-sdk/client-sts";', "Spec section 4:"],
  ["packages/core/x.ts", 'import "@aws-sdk/client-s3";', "packages/core is pure logic:"],
  ["packages/core/x.ts", 'import "node:https";', "packages/core is pure logic:"],
  ["packages/core/ledger/x.ts", 'import "big.js";', "R4:"],
  ["packages/db/x.ts", 'import "decimal.js";', "R4:"],
  ["packages/aws/x.ts", 'import "big.js";', "R4:"],
  ["apps/web/x.ts", 'import "big.js";', "R4:"],
  ["functions/scheduler/x.ts", 'import "bignumber.js";', "R4:"],
  ["packages/core/pricing/x.ts", 'import "node:https";', "packages/core is pure logic:"],
  ["apps/web/x.ts", 'import "@tc/fn-provisioner";', "R1:"],
  ["apps/admin/x.ts", 'import "../../functions/reader/index";', "R1:"],
  ["packages/db/x.ts", 'import "@tc/fn-reader";', "R1:"],
  ["packages/core/pricing/x.ts", 'import "../../aws/index";', "R1:"],
  ["apps/web/x.ts", 'await import("@tc/aws");', "R1:"],
  ["apps/admin/x.ts", 'await import("@tc/aws/adapters/linux");', "R1:"],
  ["apps/web/x.ts", 'await import("../../packages/aws/index");', "R1:"],
  ["apps/web/x.ts", "await import(`@tc/aws`);", "R1:"],
  ["apps/web/x.ts", 'const name = "@tc/aws"; await import(name);', "R1:"],
  ["packages/notify/x.ts", 'await import("@tc/aws");', "R1:"],
  ["packages/core/x.ts", 'await import("../aws/index");', "R1:"],
  ["packages/ui/x.tsx", 'export * from "@tc/aws";', "R1:"],
  ["packages/auth/x.ts", 'export { createAwsAccess } from "@tc/aws";', "R1:"],
  [
    "packages/core/x.ts",
    'export { createAwsAccess } from "@tc/aws";',
    "packages/core is pure logic:",
  ],
  ["apps/web/x.ts", 'import type { AwsError } from "@tc/aws"; export type E = AwsError;', "R1:"],
  ["apps/web/x.ts", 'const aws = require("@tc/aws"); export default aws;', "require()"],
  ["apps/web/x.ts", 'import "@aws-sdk/credential-providers";', "Spec section 4:"],
  ["apps/web/x.test.ts", 'await import("@tc/aws");', "R1:"],
  ["packages/db/test/helper.ts", 'const name = "x"; await import(name);', "R1:"],
  ["packages/ui/x.tsx", 'await import("../../functions/reader/index");', "R1:"],
  ["apps/web/x.ts", 'await import("@aws-sdk/client-lightsail");', "Spec section 4:"],
  ["apps/web/x.ts", 'await import("@aws-sdk/credential-providers/sub");', "Spec section 4:"],
  ["packages/core/x.ts", 'await import("@aws-sdk/client-sts");', "Spec section 4:"],
  ["functions/reader/x.ts", 'await import("@aws-sdk/client-sts");', "Spec section 4:"],
  ["apps/web/x.test.ts", 'await import("@aws-sdk/client-sts");', "Spec section 4:"],
  ["apps/web/x.test.ts", "await import(`@tc/aws`);", "R1:"],
  ["apps/web/x.ts", 'await import("../../PACKAGES/AWS/index");', "R1:"],
  ["apps/web/fixtures.test.data.ts", 'const n = "x"; await import(n);', "R1:"],
  [
    "apps/web/x.ts",
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("@tc/aws");',
    "R1:",
  ],
  [
    "apps/web/x.ts",
    'process.getBuiltinModule("module").createRequire(import.meta.url)("@tc/aws");',
    "R1:",
  ],
  [
    "packages/notify/x.test.ts",
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("@tc/aws");',
    "R1:",
  ],
  ["packages/ui/x.tsx", 'eval("1");', "`eval` can be harmful"],
  ["apps/web/x.ts", 'new Function("return 1")();', "Function constructor is eval"],
  ["apps/web/x.ts", 'globalThis.setTimeout("x()", 1);', "Implied eval."],
])("rejects %s with %s", async (filePath, code, prefix) => {
  const messages = await errors(filePath, code);
  expect(
    messages.some((m) => m.includes(prefix)),
    messages.join(" | "),
  ).toBe(true);
});

it.each([
  ["functions/provisioner/x.ts", 'import "@tc/aws";'],
  ["packages/aws/x.ts", 'import "@aws-sdk/client-lightsail";'],
  ["apps/web/x.ts", 'import "@aws-sdk/client-s3";'],
  ["packages/core/x.ts", 'import "@tc/db";'],
  ["packages/core/pricing/x.ts", 'import "big.js";'],
  ["functions/scheduler/x.ts", 'import "@tc/fn-reader";'],
  ["functions/provisioner/x.ts", 'await import("@tc/aws");'],
  ["apps/web/x.ts", 'await import("./chart");'],
  ["apps/web/x.ts", 'await import("@tc/awsome");'],
  ["packages/aws/x.ts", 'await import("@aws-sdk/client-lightsail");'],
  ["packages/core/naming/x.ts", 'import "../types";'],
  [
    "packages/core/pricing/x.test.ts",
    'const u = new URL("a.json", import.meta.url); await import(u.href, { with: { type: "json" } });',
  ],
  ["functions/reader/x.ts", 'const name = "x"; await import(name);'],
  ["packages/aws/x.ts", 'await import("@aws-sdk/client-sts");'],
  [
    "packages/aws/x.ts",
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("x");',
  ],
  [
    "functions/reader/x.ts",
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("x");',
  ],
  ["apps/web/x.test.ts", 'const n = "x"; await import(n);'],
  ["apps/web/x.ts", 'await import("@aws-sdk-helpers/x");'],
])("allows %s with %s", async (filePath, code) => {
  expect(await errors(filePath, code)).toEqual([]);
});

it("apps/ and packages/ hold no .jsx file, because the lint config does not cover .jsx yet (R1)", () => {
  // When this fails: first make ESLint lint .jsx files and add R1 rows for them, then remove this test.
  const tracked = listTracked(["apps", "packages"]).filter((path) => path.endsWith(".jsx"));
  expect(tracked).toEqual([]);
});
