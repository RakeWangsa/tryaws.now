import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();
async function errors(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.severity === 2).map((m) => m.message);
}

it.each([
  ["apps/web/src/x.ts", 'import "@tc/aws";', "R1:"],
  ["apps/admin/src/x.ts", 'import "@tc/aws/adapters/linux";', "R1:"],
  ["apps/web/src/x.ts", 'import "../../../packages/aws/src/index";', "R1:"],
  ["packages/db/src/x.ts", 'import "@tc/aws";', "R1:"],
  ["apps/web/src/x.ts", 'import "@aws-sdk/client-lightsail";', "Spec section 4:"],
  ["functions/reader/src/x.ts", 'import "@aws-sdk/client-sts";', "Spec section 4:"],
  ["packages/core/src/x.ts", 'import "@aws-sdk/client-s3";', "packages/core is pure logic:"],
  ["packages/core/src/x.ts", 'import "node:https";', "packages/core is pure logic:"],
])("rejects %s with %s", async (filePath, code, prefix) => {
  const messages = await errors(filePath, code);
  expect(
    messages.some((m) => m.includes(prefix)),
    messages.join(" | "),
  ).toBe(true);
});

it.each([
  ["functions/provisioner/src/x.ts", 'import "@tc/aws";'],
  ["packages/aws/src/x.ts", 'import "@aws-sdk/client-lightsail";'],
  ["apps/web/src/x.ts", 'import "@aws-sdk/client-s3";'],
  ["packages/core/src/x.ts", 'import "@tc/db";'],
])("allows %s with %s", async (filePath, code) => {
  expect(await errors(filePath, code)).toEqual([]);
});
