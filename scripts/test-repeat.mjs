import { spawn } from "node:child_process";
import { parseRepeatArgs, repeatRuns } from "./lib/test-repeat.mjs";

const spawnVitest = (args) =>
  new Promise((resolve) => {
    const child = spawn("vitest", args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });

let parsed;
try {
  parsed = parseRepeatArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
process.exitCode = await repeatRuns(parsed, spawnVitest, (line) =>
  process.stdout.write(`${line}\n`),
);
