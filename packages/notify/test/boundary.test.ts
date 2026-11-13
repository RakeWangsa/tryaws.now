import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// R1 and R3: the package is imported by the web app, so it must not hold an AWS client, a network
// call or a secret. The SES client is injected by functions/notifier. The one network call is the SMS
// gateway transport sms/gennet.ts (WPU-Z3: the web app sends the phone OTP itself, so the transport
// lives here): one constant https address, fetch injectable, and no secret read here (the caller passes
// the token and the sender id).
const ROOT = resolve(import.meta.dirname, "..");
const NETWORK_FILE = join("sms", "gennet.ts");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "test") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
const FETCH = /\bfetch\b/;

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["the AWS SDK", /from\s+["']@aws-sdk\//],
  ["@tc/aws", /from\s+["']@tc\/aws["']/],
  ["a function package", /from\s+["']@tc\/fn-/],
  ["a node network module", /from\s+["'](?:node:)?(?:http|https|tls|dgram|dns|http2)["']/],
  // node:net is allowed for isIP() (the OTP address check), never to open a socket
  ["a socket", /\b(?:createConnection|createServer|connect)\s*\(/],
  ["fetch", FETCH],
  ["process.env", /process\.env\.(?!NODE_ENV)/],
];

it("packages/notify (outside its tests) imports no AWS client, no network module and reads no secret", () => {
  const bad: string[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const [what, re] of FORBIDDEN) {
      if (what === "fetch" && file === join(ROOT, NETWORK_FILE)) continue;
      if (re.test(src)) bad.push(`${file.slice(ROOT.length)}: ${what}`);
    }
  }
  expect(bad).toEqual([]);
});

it("the one network call is the SMS gateway transport, to one constant https address (WPU-Z3)", () => {
  const users = files(ROOT).filter((file) => FETCH.test(readFileSync(file, "utf8")));
  expect(users.map((file) => file.slice(ROOT.length + 1))).toEqual([NETWORK_FILE]);
  const src = readFileSync(join(ROOT, NETWORK_FILE), "utf8");
  expect(src.match(/[a-z]+:\/\/[^\s"'`]+/gi)).toEqual([
    "https://isms.gennet.com.bd/api/v3/send-sms",
  ]);
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
