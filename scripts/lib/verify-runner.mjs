// Runs the checks of `pnpm verify` one after the other and turns each into a result.
// A command that cannot start is a failed check (spec R16), never a skipped one.
// A check that runs past its time limit, or that the caller stops, is killed together with every
// process it started and counts as failed.
import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

const TAIL_LINES = 40;
export const DEFAULT_TIMEOUT_MS = 600_000;
const STOPPED = "stopped by the caller";

function toResult(check, exitCode, output, seconds) {
  return {
    id: check.id,
    title: check.title,
    command: check.command.join(" "),
    exitCode,
    passed: exitCode === 0,
    seconds,
    tail: output.replace(/\n+$/, "").split("\n").slice(-TAIL_LINES).join("\n"),
  };
}

// The child leads its own process group (see `detached` below), so the kill reaches what it started.
function killTree(child) {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process is gone already.
  }
}

function runOne(check, cwd, signal) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let output = "";
    let child;
    let timer;
    let done = false;
    const onAbort = () => stop(STOPPED);
    const finish = (exitCode, text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(toResult(check, exitCode, text, Math.round((Date.now() - started) / 100) / 10));
    };
    // Finishes at once: a process that escaped the group could hold the pipes open.
    const stop = (line) => {
      if (done) return;
      killTree(child);
      const before = output.replace(/\n+$/, "");
      finish(null, before === "" ? line : `${before}\n${line}`);
    };
    try {
      child = spawn(check.command[0], check.command.slice(1), {
        cwd,
        detached: process.platform !== "win32",
      });
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
    child.on("close", (code, sig) => {
      finish(code ?? null, sig ? `${output}\nkilled by ${sig}` : output);
    });
    timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000} s`), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runChecks(checks, { cwd = process.cwd(), signal } = {}) {
  const results = [];
  for (const check of checks) {
    results.push(
      signal?.aborted ? toResult(check, null, STOPPED, 0) : await runOne(check, cwd, signal),
    );
  }
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
