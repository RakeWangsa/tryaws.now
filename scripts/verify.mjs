/* global AbortController */
// pnpm verify --quick | --task <id> | --gate <M0..M7>
// Runs the checks, prints a table, writes verify/report-<name>.json and exits 0 only if all passed.
import { resolve } from "node:path";
import { listChangedFiles, readWorkspacePackages } from "./lib/changed-packages.mjs";
import { abortOnSignals } from "./lib/abort-on-signals.mjs";
import { verifyMain } from "./lib/verify-main.mjs";
import { runChecks } from "./lib/verify-runner.mjs";

const root = resolve(import.meta.dirname, "..");
// A check runs in its own process group, so a Ctrl-C or a closed terminal does not reach it by
// itself: the command stops the checks when it is interrupted, terminated or hung up. `on`, not
// `once`: pnpm forwards the signal as well, and a second SIGINT with no handler would kill the
// command before it writes its report.
const controller = new AbortController();
abortOnSignals(controller);
const { exitCode, output } = await verifyMain(process.argv.slice(2), {
  root,
  runChecks,
  listChangedFiles,
  readPackages: readWorkspacePackages,
  signal: controller.signal,
});
process.stdout.write(`${output}\n`);
process.exitCode = exitCode;
