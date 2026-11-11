import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { expect, it } from "vitest";
import { importsOfTestingEntry } from "./testing-imports.mjs";

const SKIP = new Set(["node_modules", ".next", ".open-next", ".sst", "dist", "test"]);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = posix.join(dir, e.name);
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(p);
    return e.isFile() ? [p] : [];
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
    ]),
  ).toEqual(["apps/web/a.ts", "apps/web/b.ts", "packages/db/repositories/c.ts"]);
});

it("no production file imports @tc/db/testing (test helpers stay out of every bundle)", () => {
  const files = ["apps", "packages", "functions"]
    .flatMap(walk)
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !f.startsWith("packages/db/testing/"));
  expect(files.length).toBeGreaterThanOrEqual(20);
  expect(importsOfTestingEntry(files.map((f) => [f, readFileSync(f, "utf8")]))).toEqual([]);
});
