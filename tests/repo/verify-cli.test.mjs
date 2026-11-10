import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { GATES, TASKS } from "../../verify/checks.mjs";

const verify = (...args) =>
  spawnSync("node", ["scripts/verify.mjs", ...args], { encoding: "utf8" });

it("gate M0 and task WP0-T1 are the same five checks", () => {
  expect(GATES.M0.map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "test",
  ]);
  expect(TASKS["WP0-T1"]).toEqual(GATES.M0);
  expect(GATES.M0.map((c) => c.command.join(" "))).toEqual([
    "pnpm spec:check",
    "pnpm baseline:check",
    "pnpm lint",
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
