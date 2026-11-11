import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { GATES, TASKS, quickChecks } from "../../verify/checks.mjs";

const verify = (...args) =>
  spawnSync("node", ["scripts/verify.mjs", ...args], { encoding: "utf8" });

it("gate M0 and task WP0-T1 are the same six checks", () => {
  expect(GATES.M0.map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "format",
    "typecheck",
    "test",
  ]);
  expect(TASKS["WP0-T1"]).toEqual(GATES.M0);
  expect(GATES.M0.map((c) => c.command.join(" "))).toEqual([
    "pnpm spec:check",
    "pnpm baseline:check",
    "pnpm lint",
    "pnpm format:check",
    "pnpm typecheck",
    "pnpm test",
  ]);
});
it.each([
  [["--gate", "M3"], "Gate M3 has no checks yet", "gate-M3"],
  [["--gate", "M9"], "Gate M9 does not exist", "gate-M9"],
  [["--task", "WP3-T1"], "Task WP3-T1 has no proof yet", "task-WP3-T1"],
])("fails closed for %j", (args, title, name) => {
  rmSync(`verify/report-${name}.json`, { force: true });
  const result = verify(...args);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(title);
  const report = JSON.parse(readFileSync(`verify/report-${name}.json`, "utf8"));
  expect(report).toMatchObject({ name, passed: false });
  expect(report.results[0]).toMatchObject({ id: "not-defined", passed: false });
});
it("fails closed with no mode and with two modes", () => {
  rmSync("verify/report-usage.json", { force: true });
  expect(verify().status).toBe(1);
  const report = JSON.parse(readFileSync("verify/report-usage.json", "utf8"));
  expect(report).toMatchObject({ name: "usage", passed: false });
  expect(report.results[0]).toMatchObject({
    id: "not-defined",
    title: "Choose one of --quick, --task <id> or --gate <gate>",
  });
  expect(verify("--quick", "--gate", "M0").status).toBe(1);
});
it.each([
  [["@tc/core"], "pnpm --filter ...@tc/core typecheck"],
  [["@tc/core", "@tc/web"], "pnpm --filter ...@tc/core --filter ...@tc/web typecheck"],
])("--quick type-checks %j and every package that depends on it", (packages, command) => {
  const commands = quickChecks(packages).map((c) => c.command.join(" "));
  expect(commands).toContain(command);
});
it("--quick never selects only what a changed package depends on", () => {
  const words = quickChecks(["@tc/core", "@tc/web"]).flatMap((c) => c.command);
  expect(words.filter((word) => word.endsWith("..."))).toEqual([]);
});

it("task WP1-T1 is proven by the checks of M0 plus Prettier, the schema tests and the repository tests", () => {
  expect(TASKS["WP1-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP0-T1"]).toEqual(GATES.M0);
});

it("task WP4-T1 is proven by lint, types, format, the aws and core tests and the repository tests", () => {
  expect(TASKS["WP4-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // every other key of TASKS is unchanged
  expect(Object.keys(TASKS).sort()).toEqual(["WP0-T1", "WP1-T1", "WP1-T2", "WP4-T1", "WPU-T1"]);
});

it("task WPU-T1 is proven by lint, types, format, the ui tests, the two theme checks and the repository tests", () => {
  expect(TASKS["WPU-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["theme-import", "pnpm theme:sync --stage import --check"],
    ["theme-publish", "pnpm theme:sync --stage publish"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WP1-T2 is proven by the checks of WP1-T1, the cross-tenant proof and the tests of @tc/core", () => {
  expect(TASKS["WP1-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["cross-tenant", "pnpm test --filter @tc/db test/cross-tenant --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // the filter must keep matching real files
  for (const f of [
    "packages/db/test/cross-tenant.test.ts",
    "packages/db/test/cross-tenant-helper.test.ts",
  ])
    expect(existsSync(f), f).toBe(true);
});
