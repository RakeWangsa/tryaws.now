// pnpm verify --quick | --task <id> | --gate <M0..M7>
// Runs the checks, prints a table, writes verify/report-<name>.json and exits 0 only if all passed.
import { resolve } from "node:path";
import { listChangedFiles, readWorkspacePackages } from "./lib/changed-packages.mjs";
import { verifyMain } from "./lib/verify-main.mjs";
import { runChecks } from "./lib/verify-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const { exitCode, output } = await verifyMain(process.argv.slice(2), {
  root,
  runChecks,
  listChangedFiles,
  readPackages: readWorkspacePackages,
});
process.stdout.write(`${output}\n`);
process.exitCode = exitCode;
