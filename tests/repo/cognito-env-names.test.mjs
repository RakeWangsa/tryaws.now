// The Cognito variables the SST stack hands to each app must be the names packages/auth/config.ts reads
// (found 2026-11-14: the stack set COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID, which nothing reads).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const web = readFileSync(resolve(root, "infra/stacks/web.ts"), "utf8");
const auth = readFileSync(resolve(root, "packages/auth/config.ts"), "utf8");

it("every Cognito variable the apps read is set by the stack, and the stack sets no other", () => {
  const read = new Set(auth.match(/COGNITO_[A-Z_]+/g));
  const set = new Set([...web.matchAll(/^\s*(COGNITO_[A-Z_]+):/gm)].map((m) => m[1]));
  expect([...read].sort()).toEqual([
    "COGNITO_ADMIN_CLIENT_ID",
    "COGNITO_ADMIN_POOL_ID",
    "COGNITO_CUSTOMER_CLIENT_ID",
    "COGNITO_CUSTOMER_POOL_ID",
  ]);
  expect([...set].sort()).toEqual([...read].sort());
});
