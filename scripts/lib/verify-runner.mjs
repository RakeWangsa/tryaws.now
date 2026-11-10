// Runs the checks of `pnpm verify` one after the other and turns each into a result.
// A command that cannot start is a failed check (spec R16), never a skipped one.
import { spawn } from "node:child_process";

const TAIL_LINES = 40;

function runOne(check, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const finish = (exitCode, output) => {
      const lines = output.replace(/\n+$/, "").split("\n");
      resolve({
        id: check.id,
        title: check.title,
        command: check.command.join(" "),
        exitCode,
        passed: exitCode === 0,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        tail: lines.slice(-TAIL_LINES).join("\n"),
      });
    };
    let output = "";
    let child;
    try {
      child = spawn(check.command[0], check.command.slice(1), { cwd });
    } catch (error) {
      finish(null, `cannot run: ${error.message}`);
      return;
    }
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(null, `cannot run: ${error.message}`));
    child.on("close", (code, signal) => {
      finish(code ?? null, signal ? `${output}\nkilled by ${signal}` : output);
    });
  });
}

export async function runChecks(checks, { cwd = process.cwd() } = {}) {
  const results = [];
  for (const check of checks) results.push(await runOne(check, cwd));
  return results;
}

export function formatTable(results) {
  const idWidth = Math.max(0, ...results.map((r) => r.id.length));
  const titleWidth = Math.max(0, ...results.map((r) => r.title.length));
  return results
    .map((r) => {
      const status = r.passed ? "pass" : "FAIL";
      return `${r.id.padEnd(idWidth)} | ${r.title.padEnd(titleWidth)} | ${status}  ${r.seconds}s`;
    })
    .join("\n");
}
