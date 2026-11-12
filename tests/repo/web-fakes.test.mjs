import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";

// R3, R6, R16 for apps/web: the fake EPS and the dev sign-in exist only in apps/web/server/fakes.
// Production code reaches them through one literal dynamic import in apps/web/server/runtime.ts, and
// that import runs only when the configuration says fakes (config.ts refuses that in staging and
// production). These tests keep the doors to the fakes from multiplying; runtime.test.ts proves
// that a production configuration never runs the import.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB = "apps/web";
const FAKES_FOLDER = "apps/web/server/fakes/";
const RUNTIME = "apps/web/server/runtime.ts";
// The other files that may reach the fakes, each only through literal dynamic import()s: the proxy
// runtime of the refresh and the two dev outbox routes (WP2-T2). All three check the fake switches
// of config.ts first, and the routes answer 404 without them.
const OTHER_DOORS = [
  "apps/web/server/proxy-auth.ts",
  "apps/web/app/dev/idp/outbox/route.ts",
  "apps/web/app/dev/sms/outbox/route.ts",
];
const BUILD_FOLDERS = new Set(["node_modules", ".next", ".open-next", ".sst", "dist"]);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const walk = (dir) =>
  readdirSync(posix.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = posix.join(dir, e.name);
    if (e.isDirectory()) return BUILD_FOLDERS.has(e.name) ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });
const read = (f) => readFileSync(posix.join(ROOT, f), "utf8");
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const webSources = () => walk(WEB).filter((f) => SOURCE_FILE.test(f));
const productionFiles = () =>
  webSources().filter((f) => !TEST_FILE.test(f) && !f.startsWith(FAKES_FOLDER));

const STATIC_SPECIFIER = /(?:\bfrom\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const touchesFakes = (specifier) => /(^|\/)fakes(\/|$)/.test(specifier);
const staticFakes = (text) =>
  [...stripComments(text).matchAll(STATIC_SPECIFIER)].map((m) => m[1]).filter(touchesFakes);
const dynamicFakes = (text) =>
  [...stripComments(text).matchAll(DYNAMIC_SPECIFIER)].map((m) => m[1]).filter(touchesFakes);
const namesFake = (text) =>
  /\b(?:InMemoryEps|InMemoryIdentityProvider|fakeRefreshPort)\b/.test(text);

it("the scans see what they are meant to see", () => {
  expect(staticFakes('import { x } from "./fakes/eps-bridge.ts";')).toEqual([
    "./fakes/eps-bridge.ts",
  ]);
  expect(staticFakes('export * from "../server/fakes/dev-auth"')).toEqual([
    "../server/fakes/dev-auth",
  ]);
  expect(staticFakes('import "./fakes/a.ts"')).toEqual(["./fakes/a.ts"]);
  expect(staticFakes('const m = require("./fakes/a.ts")')).toEqual(["./fakes/a.ts"]);
  expect(staticFakes('// import x from "./fakes/a.ts"')).toEqual([]);
  expect(staticFakes('import x from "./fakeshop"')).toEqual([]);
  expect(dynamicFakes('const m = await import("./fakes/eps-bridge.ts");')).toEqual([
    "./fakes/eps-bridge.ts",
  ]);
  expect(dynamicFakes("await import(`./fakes/eps-bridge.ts`)")).toEqual([]);
  expect(namesFake("new InMemoryEps()")).toBe(true);
  expect(namesFake("new InMemoryEpsX()")).toBe(false);
  expect(namesFake("new InMemoryIdentityProvider({})")).toBe(true);
  expect(namesFake("fakeRefreshPort()")).toBe(true);
});

it("the fake class and port names appear in no file of apps/web outside server/fakes and tests", () => {
  const offenders = productionFiles().filter((f) => namesFake(read(f)));
  expect(offenders).toEqual([]);
});

it("the fakes are imported by no file of apps/web except runtime.ts and the three named doors", () => {
  const offenders = productionFiles()
    .filter((f) => f !== RUNTIME && !OTHER_DOORS.includes(f))
    .filter((f) => {
      const text = read(f);
      return staticFakes(text).length > 0 || dynamicFakes(text).length > 0;
    });
  expect(offenders).toEqual([]);
});

it("runtime.ts imports the fakes only through a literal dynamic import()", () => {
  const text = read(RUNTIME);
  expect(staticFakes(text)).toEqual([]);
  const dynamic = dynamicFakes(text);
  expect(dynamic.sort()).toEqual([
    "./fakes/account-fakes.ts",
    "./fakes/dev-auth.ts",
    "./fakes/eps-bridge.ts",
    "./fakes/identity.ts",
    "./fakes/kyc-fakes.ts",
    "./fakes/outbox.ts",
    "./fakes/reader-fake.ts",
  ]);
  // Every import( in the file has a string literal: nothing is computed.
  const all = stripComments(text).match(/\bimport\s*\(/g) ?? [];
  expect(all).toHaveLength(dynamic.length);
});

it("the three other doors use only literal dynamic import()s and no static import of a fake", () => {
  for (const f of OTHER_DOORS) {
    const text = read(f);
    expect(staticFakes(text), f).toEqual([]);
    const dynamic = dynamicFakes(text);
    expect(dynamic.length, f).toBeGreaterThan(0);
    const all = stripComments(text).match(/\bimport\s*\(/g) ?? [];
    expect(all, f).toHaveLength(dynamic.length);
  }
});

it("the fake files are not exported through any index of the web app", () => {
  for (const f of webSources().filter((f) => /(^|\/)index\.(ts|tsx|mjs|js)$/.test(f))) {
    expect(staticFakes(read(f)), f).toEqual([]);
    expect(dynamicFakes(read(f)), f).toEqual([]);
  }
});
