import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { expect, it } from "vitest";
import { importsOfTestingEntry } from "./testing-imports.mjs";

// Dependencies and build output are skipped at any depth. A folder named test is skipped only when
// it is the test folder of a package, directly in apps/<name>, packages/<name> or functions/<name>:
// a route such as apps/web/app/test/ is production code.
const BUILD_FOLDERS = new Set(["node_modules", ".next", ".open-next", ".sst", "dist"]);
const PACKAGE_TEST_FOLDER = /^(?:apps|packages|functions)\/[^/]+\/test$/;
const skipsDirectory = (dir) =>
  BUILD_FOLDERS.has(posix.basename(dir)) || PACKAGE_TEST_FOLDER.test(dir);
const EXTENSIONS = "ts|tsx|mts|cts|mjs|cjs|js";
const SOURCE_FILE = new RegExp(`\\.(${EXTENSIONS})$`);
const TEST_FILE = new RegExp(`\\.test\\.(${EXTENSIONS})$`);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = posix.join(dir, e.name);
    if (e.isDirectory()) return skipsDirectory(p) ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });

it("the walk skips the build folders and the test folder of a package, and nothing else", () => {
  const rows = [
    ["packages/db/test", true],
    ["functions/reader/test", true],
    ["apps/web/app/test", false],
    ["packages/db/testing", false],
    ["packages/db/repositories/test-helpers", false],
    ["apps/web/node_modules", true],
    ["apps/web/.next", true],
  ];
  expect(rows.map(([dir]) => [dir, skipsDirectory(dir)])).toEqual(rows);
});

it("the scan finds the package name and a relative path to packages/db/testing, and nothing else", () => {
  expect(
    importsOfTestingEntry([
      ["apps/web/a.ts", 'import { useTempDatabase } from "@tc/db/testing";'],
      ["apps/web/b.ts", 'export * from "../../packages/db/testing/index";'],
      ["packages/db/repositories/c.ts", 'import { tenantSnapshot } from "../testing";'],
      ["packages/core/d.ts", 'import type { Tx } from "@tc/db";'],
      ["packages/db/e.ts", 'import { withTx } from "./tx";'],
      ["apps/web/f.ts", "// the helpers of @tc/db/testing are for tests only"],
      ["apps/web/g.ts", 'await import("@tc/db/testing");'],
      ["apps/web/h.ts", 'import "@tc/db/testing";'],
      ["functions/reader/i.ts", "await import(`@tc/db/testing`);"],
      ["apps/web/j.ts", 'import t = require("@tc/db/testing");'],
      ["functions/reader/k.ts", 'const t = require("../../packages/db/testing/index");'],
      ["apps/web/l.ts", "await import(`@tc/db/${name}`);"],
      ["apps/web/m.ts", "await import(`@tc/db/testing/${name}`);"],
    ]),
  ).toEqual([
    "apps/web/a.ts",
    "apps/web/b.ts",
    "packages/db/repositories/c.ts",
    "apps/web/g.ts",
    "apps/web/h.ts",
    "functions/reader/i.ts",
    "apps/web/j.ts",
    "functions/reader/k.ts",
  ]);
});

it("no production file imports @tc/db/testing (test helpers stay out of every bundle)", () => {
  const files = ["apps", "packages", "functions"]
    .flatMap(walk)
    .filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f))
    .filter((f) => !f.startsWith("packages/db/testing/"));
  expect(files.length).toBeGreaterThanOrEqual(20);
  expect(importsOfTestingEntry(files.map((f) => [f, readFileSync(f, "utf8")]))).toEqual([]);
});
