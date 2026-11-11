import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// R1 and R3: the package is imported by the web app, so it must not hold an AWS client, a network
// call or a secret. The SES and SMS clients are injected by functions/notifier.
const ROOT = resolve(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "test") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["the AWS SDK", /from\s+["']@aws-sdk\//],
  ["@tc/aws", /from\s+["']@tc\/aws["']/],
  ["a function package", /from\s+["']@tc\/fn-/],
  ["a node network module", /from\s+["'](?:node:)?(?:http|https|tls|dgram|dns|http2)["']/],
  // node:net is allowed for isIP() (the OTP address check), never to open a socket
  ["a socket", /\b(?:createConnection|createServer|connect)\s*\(/],
  ["fetch", /\bfetch\s*\(/],
  ["process.env", /process\.env\.(?!NODE_ENV)/],
];

it("packages/notify (outside its tests) imports no AWS client, no network module and reads no secret", () => {
  const bad: string[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const [what, re] of FORBIDDEN)
      if (re.test(src)) bad.push(`${file.slice(ROOT.length)}: ${what}`);
  }
  expect(bad).toEqual([]);
});

it("packages/core never imports @tc/notify (ruling A: the arrow points from notify to core)", () => {
  const core = resolve(ROOT, "..", "core");
  const bad: string[] = [];
  for (const file of files(core)) {
    if (/from\s+["']@tc\/notify["']/.test(readFileSync(file, "utf8")))
      bad.push(file.slice(core.length));
  }
  expect(bad).toEqual([]);
});
