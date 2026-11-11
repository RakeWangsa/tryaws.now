import { ESLint } from "eslint";
import { expect, it } from "vitest";

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
])("allows %s with %s", async (filePath, code) => {
  expect(await errors(filePath, code)).toEqual([]);
});
