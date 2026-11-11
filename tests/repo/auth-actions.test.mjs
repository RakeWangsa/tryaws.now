import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";

// R1, R3, R9, R14 for the action cores of the auth screens (WP2-T2): they are plain functions of
// apps/web/server/auth. They import nothing of Next, React or AWS, read no environment, write no
// console line (apps/web/server/log.ts is the one sink), and run the authorize step before the parser.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FOLDER = "apps/web/server/auth";
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs)$/;
const CORES = [
  "sign-up.ts",
  "confirm-email.ts",
  "resend-email-code.ts",
  "sign-in.ts",
  "sign-out.ts",
  "request-reset.ts",
  "reset-password.ts",
  "phone.ts",
];

const files = () =>
  readdirSync(posix.join(ROOT, FOLDER), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => posix.join(FOLDER, e.name));
const read = (f) => readFileSync(posix.join(ROOT, f), "utf8");
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const production = () => files().filter((f) => !TEST_FILE.test(f));

const IMPORT = /(?:\bfrom\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const importsOf = (text) => [...strip(text).matchAll(IMPORT)].map((m) => m[1]);

it("the scans see what they are meant to see", () => {
  expect(importsOf('import { x } from "next/headers";')).toEqual(["next/headers"]);
  expect(importsOf("import type { A } from 'react';")).toEqual(["react"]);
  expect(importsOf('// import x from "next/headers"')).toEqual([]);
});

it("the folder holds the eight cores", () => {
  const names = files().map((f) => posix.basename(f));
  for (const core of CORES) expect(names, core).toContain(core);
});

it("no file imports next/*, react, @tc/aws or an AWS SDK", () => {
  const offenders = production().filter((f) =>
    importsOf(read(f)).some(
      (s) =>
        s === "react" ||
        s.startsWith("react/") ||
        s === "react-dom" ||
        s.startsWith("next/") ||
        s === "next" ||
        s.startsWith("next-intl") ||
        s === "@tc/aws" ||
        s.startsWith("@aws-sdk/") ||
        s.startsWith("@smithy/"),
    ),
  );
  expect(offenders).toEqual([]);
});

it("no file reads process.env or writes a console line", () => {
  const env = production().filter((f) => /\bprocess\s*\.\s*env\b/.test(strip(read(f))));
  const out = production().filter((f) => /\bconsole\s*\./.test(strip(read(f))));
  expect(env).toEqual([]);
  expect(out).toEqual([]);
});

it("every core runs the authorize step (gate or assertSameOrigin) before its parser", () => {
  for (const core of CORES) {
    const text = strip(read(posix.join(FOLDER, core)));
    const authorize = Math.min(
      ...["gate(ctx)", "assertSameOrigin("].map((s) => {
        const at = text.indexOf(s);
        return at === -1 ? Number.POSITIVE_INFINITY : at;
      }),
    );
    expect(authorize, `${core} has no authorize step`).toBeLessThan(Number.POSITIVE_INFINITY);
    const parser = text.search(/\bparse[A-Z]\w*Form\(/);
    if (parser !== -1) expect(authorize, `${core}: authorize before parse`).toBeLessThan(parser);
  }
});

it("no core builds a Set-Cookie string or names a session cookie", () => {
  for (const f of production()) {
    const text = strip(read(f));
    expect(/set-cookie/i.test(text), f).toBe(false);
    expect(/__Host-tc_(?:at|rt)\b/.test(text), f).toBe(false);
  }
});
