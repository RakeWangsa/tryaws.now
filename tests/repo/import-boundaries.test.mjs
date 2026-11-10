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
])("allows %s with %s", async (filePath, code) => {
  expect(await errors(filePath, code)).toEqual([]);
});
