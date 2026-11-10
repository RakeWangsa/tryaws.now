// pnpm verify --quick | --task <id> | --gate <M0..M7>
// Runs the checks, prints a table, writes verify/report-<name>.json and exits 0 only if all passed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GATES, TASKS, quickChecks } from "../verify/checks.mjs";
import { changedPackages, readWorkspacePackages } from "./lib/changed-packages.mjs";
import { formatTable, runChecks } from "./lib/verify-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const out = (text) => process.stdout.write(`${text}\n`);

const USAGE = "Choose one of --quick, --task <id> or --gate <gate>";

function notDefined(title) {
  return [
    { id: "not-defined", title, command: "", exitCode: null, passed: false, seconds: 0, tail: "" },
  ];
}

// Returns { name, checks } or { name, results } when the request cannot run.
function plan(argv) {
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quick") {
      modes.push({ mode: "quick" });
    } else if (arg === "--task" || arg === "--gate") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { name: "usage", results: notDefined(USAGE) };
      modes.push({ mode: arg.slice(2), value });
      i++;
    } else {
      return { name: "usage", results: notDefined(USAGE) };
    }
  }
  if (modes.length !== 1) return { name: "usage", results: notDefined(USAGE) };

  const [{ mode, value }] = modes;
  if (mode === "quick") return { name: "quick", checks: quickChecks(quickScope()) };
  if (mode === "task") {
    const checks = Object.hasOwn(TASKS, value) ? TASKS[value] : [];
    return checks.length > 0
      ? { name: `task-${value}`, checks }
      : { name: `task-${value}`, results: notDefined(`Task ${value} has no proof yet`) };
  }
  if (!Object.hasOwn(GATES, value)) {
    return { name: `gate-${value}`, results: notDefined(`Gate ${value} does not exist`) };
  }
  return GATES[value].length > 0
    ? { name: `gate-${value}`, checks: GATES[value] }
    : { name: `gate-${value}`, results: notDefined(`Gate ${value} has no checks yet`) };
}

// Changed files: tracked changes against HEAD plus untracked files. When git cannot tell, check everything.
function quickScope() {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const changed = git("diff", "--name-only", "HEAD");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  if (changed.status !== 0 || untracked.status !== 0) return "all";
  const files = `${changed.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean);
  return changedPackages(files, readWorkspacePackages(root));
}

const request = plan(process.argv.slice(2));
const results = request.results ?? (await runChecks(request.checks, { cwd: root }));
const passed = results.length > 0 && results.every((r) => r.passed);

out(formatTable(results));
for (const r of results.filter((x) => !x.passed && x.tail !== "")) {
  out(`\n--- ${r.id}: ${r.command} (exit ${r.exitCode}) ---\n${r.tail}`);
}
out(passed ? "\nverify: all checks passed" : "\nverify: FAILED");

// The report name becomes a file name, so it keeps only safe characters.
const fileName = request.name.replace(/[^A-Za-z0-9._-]/g, "_");
mkdirSync(resolve(root, "verify"), { recursive: true });
writeFileSync(
  resolve(root, "verify", `report-${fileName}.json`),
  `${JSON.stringify({ name: request.name, passed, results }, null, 2)}\n`,
);
process.exitCode = passed ? 0 : 1;
