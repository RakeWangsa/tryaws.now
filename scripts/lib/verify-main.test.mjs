/* global AbortController */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listChangedFiles } from "./changed-packages.mjs";
import { verifyMain } from "./verify-main.mjs";
import { runChecks } from "./verify-runner.mjs";

const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const reportOf = (root, name) =>
  JSON.parse(readFileSync(join(root, "verify", `report-${name}.json`), "utf8"));
const boom = async () => {
  throw new Error("the runner broke");
};
const deps = (root, over = {}) => ({
  root,
  runChecks: boom,
  listChangedFiles: () => ["packages/a/x.ts"],
  readPackages: () => ({ "packages/a": "@tc/a" }),
  ...over,
});

function expectRunnerError(report, name) {
  expect(report.name).toBe(name);
  expect(report.passed).toBe(false);
  expect(report.results).toHaveLength(1);
  expect(report.results[0]).toMatchObject({
    id: "runner-error",
    title: "The verify command failed to run",
    passed: false,
    exitCode: null,
  });
  expect(report.results[0].tail.startsWith("runner error:")).toBe(true);
  expect(report.results[0].tail).toContain("the runner broke");
  expect(report.results[0].tail.split("\n").length).toBeLessThanOrEqual(40);
}

it("writes a failed runner-error report when the runner throws", async () => {
  const root = tmp("vm-");
  const { exitCode, report, output } = await verifyMain(["--gate", "M0"], deps(root));
  expect(exitCode).toBe(1);
  expectRunnerError(report, "gate-M0");
  expectRunnerError(reportOf(root, "gate-M0"), "gate-M0");
  expect(output).toContain("The verify command failed to run");
  expect(output).toContain("runner error:");
});
it("removes an older passing report of the same name before it runs", async () => {
  const root = tmp("vm-");
  mkdirSync(join(root, "verify"));
  const file = join(root, "verify", "report-gate-M0.json");
  writeFileSync(file, '{ "name": "gate-M0", "passed": true, "results": [] }\n');
  await verifyMain(["--gate", "M0"], deps(root));
  expect(reportOf(root, "gate-M0").passed).toBe(false);
  writeFileSync(file, '{ "passed": true }\n');
  let seen;
  await verifyMain(
    ["--gate", "M0"],
    deps(root, {
      runChecks: async () => {
        seen = existsSync(file);
        throw new Error("the runner broke");
      },
    }),
  );
  expect(seen).toBe(false);
});
it("reports a runner-error under quick when the package reader throws", async () => {
  const root = tmp("vm-");
  const readPackages = () => {
    throw new Error("the runner broke");
  };
  const { exitCode } = await verifyMain(["--quick"], deps(root, { readPackages }));
  expect(exitCode).toBe(1);
  expectRunnerError(reportOf(root, "quick"), "quick");
});
it("puts the tails of failed checks before the table", async () => {
  const root = tmp("vm-");
  const failing = {
    id: "lint",
    title: "ESLint",
    command: "pnpm lint",
    exitCode: 1,
    passed: false,
    seconds: 0.1,
    tail: "UNIQUE-TAIL-TEXT",
  };
  const { output, exitCode } = await verifyMain(
    ["--gate", "M0"],
    deps(root, { runChecks: async () => [failing] }),
  );
  expect(exitCode).toBe(1);
  expect(output.indexOf("UNIQUE-TAIL-TEXT")).toBeGreaterThanOrEqual(0);
  expect(output.indexOf("UNIQUE-TAIL-TEXT")).toBeLessThan(output.indexOf("| FAIL"));
});
it("passes deps.signal on to the runner: an aborted signal stops every check", async () => {
  const root = tmp("vm-");
  const controller = new AbortController();
  controller.abort();
  const { exitCode, report } = await verifyMain(
    ["--gate", "M0"],
    deps(root, { runChecks, signal: controller.signal }),
  );
  expect(exitCode).toBe(1);
  expect(report.passed).toBe(false);
  expect(report.results.length).toBeGreaterThan(0);
  for (const r of report.results) {
    expect(r).toMatchObject({ passed: false, exitCode: null, seconds: 0 });
    expect(r.tail).toBe("stopped by the caller");
  }
});

it("lists both the old and the new path of a staged rename", () => {
  const dir = tmp("rename-");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "packages/a"), { recursive: true });
  mkdirSync(join(dir, "packages/b"), { recursive: true });
  writeFileSync(join(dir, "packages/a/x.ts"), "export const x = 1;\n");
  git("add", "packages/a/x.ts");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
  git("mv", "packages/a/x.ts", "packages/b/x.ts");
  expect(listChangedFiles(dir).sort()).toEqual(["packages/a/x.ts", "packages/b/x.ts"]);
});
