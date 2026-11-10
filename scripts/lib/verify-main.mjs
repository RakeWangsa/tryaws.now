// The flow of `pnpm verify`: read the request, run the checks, write verify/report-<name>.json.
// It never throws: when something breaks, the report says so (spec R16, fail closed).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATES, TASKS, quickChecks } from "../../verify/checks.mjs";
import { changedPackages } from "./changed-packages.mjs";
import { formatTable } from "./verify-runner.mjs";

const USAGE = "Choose one of --quick, --task <id> or --gate <gate>";
const TAIL_LINES = 40;

const failed = (id, title, tail = "") => ({
  id,
  title,
  command: "",
  exitCode: null,
  passed: false,
  seconds: 0,
  tail,
});
const notDefined = (title) => [failed("not-defined", title)];

// What was asked: { name, mode, value } or { name, results } when it cannot run.
function parseRequest(argv) {
  const usage = { name: "usage", results: notDefined(USAGE) };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quick") {
      modes.push({ mode: "quick" });
    } else if (arg === "--task" || arg === "--gate") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return usage;
      modes.push({ mode: arg.slice(2), value });
      i++;
    } else {
      return usage;
    }
  }
  if (modes.length !== 1) return usage;

  const { mode, value } = modes[0];
  if (mode === "quick") return { name: "quick", mode };
  if (mode === "task") {
    return Object.hasOwn(TASKS, value) && TASKS[value].length > 0
      ? { name: `task-${value}`, checks: TASKS[value] }
      : { name: `task-${value}`, results: notDefined(`Task ${value} has no proof yet`) };
  }
  if (!Object.hasOwn(GATES, value)) {
    return { name: `gate-${value}`, results: notDefined(`Gate ${value} does not exist`) };
  }
  return GATES[value].length > 0
    ? { name: `gate-${value}`, checks: GATES[value] }
    : { name: `gate-${value}`, results: notDefined(`Gate ${value} has no checks yet`) };
}

function render(results, passed) {
  const parts = [];
  for (const r of results.filter((x) => !x.passed && x.tail !== "")) {
    parts.push(`--- ${r.id}: ${r.command} (exit ${r.exitCode}) ---\n${r.tail}\n`);
  }
  parts.push(formatTable(results), passed ? "\nverify: all checks passed" : "\nverify: FAILED");
  return parts.join("\n");
}

// deps: { root, runChecks, listChangedFiles, readPackages }
// Returns { exitCode, report, output }; the report is also on disk.
export async function verifyMain(argv, deps, signal) {
  const { root, runChecks, listChangedFiles, readPackages } = deps;
  let name = "usage";
  let results;
  let file;
  try {
    const request = parseRequest(argv);
    name = request.name;
    // The report name becomes a file name, so it keeps only safe characters.
    file = join(root, "verify", `report-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    rmSync(file, { force: true });
    if (request.results) {
      results = request.results;
    } else {
      let checks = request.checks;
      if (request.mode === "quick") {
        const files = listChangedFiles(root);
        checks = quickChecks(files === null ? "all" : changedPackages(files, readPackages(root)));
      }
      results = await runChecks(checks, { cwd: root, signal });
    }
  } catch (error) {
    const text = `runner error: ${error?.message ?? error}\n${error?.stack ?? ""}`;
    const tail = text.replace(/\n+$/, "").split("\n").slice(0, TAIL_LINES).join("\n");
    results = [failed("runner-error", "The verify command failed to run", tail)];
  }

  const passed = results.length > 0 && results.every((r) => r.passed);
  const report = { name, passed, results };
  file ??= join(root, "verify", "report-usage.json");
  mkdirSync(join(root, "verify"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: passed ? 0 : 1, report, output: render(results, passed) };
}
