/* global AbortController */
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, formatTable, runChecks } from "./verify-runner.mjs";

const node = (code) => ["node", "-e", code];

it("passes a command that exits 0 and fails one that does not", async () => {
  const results = await runChecks([
    { id: "ok", title: "Exits 0", command: node("process.exit(0)") },
    { id: "bad", title: "Exits 3", command: node("console.log('why'); process.exit(3)") },
  ]);
  expect(results.map((r) => [r.id, r.passed, r.exitCode])).toEqual([
    ["ok", true, 0],
    ["bad", false, 3],
  ]);
  expect(results[1].tail).toContain("why");
  expect(results[1].command).toBe("node -e console.log('why'); process.exit(3)");
});
it("counts a command that cannot start as failed", async () => {
  const [result] = await runChecks([
    { id: "gone", title: "Missing tool", command: ["no-such-tool-xyz"] },
  ]);
  expect(result.passed).toBe(false);
  expect(result.exitCode).toBe(null);
  expect(result.tail.startsWith("cannot run:")).toBe(true);
});
it("says when a check was killed by a signal", async () => {
  const [result] = await runChecks([
    { id: "sig", title: "Killed", command: node("process.kill(process.pid, 'SIGTERM')") },
  ]);
  expect(result.passed).toBe(false);
  expect(result.exitCode).toBe(null);
  expect(result.tail).toContain("killed by SIGTERM");
  expect(result.tail.trim().split("\n").at(-1)).toBe("killed by SIGTERM");
});
it("keeps the last 40 lines of output", async () => {
  const [result] = await runChecks([
    {
      id: "long",
      title: "Long",
      command: node("for (let i = 1; i <= 100; i++) console.log('line ' + i)"),
    },
  ]);
  const lines = result.tail.trim().split("\n");
  expect(lines).toHaveLength(40);
  expect(lines[0]).toBe("line 61");
});
it("prints one row per check with pass or fail", () => {
  const table = formatTable([
    { id: "ok", title: "Exits 0", command: "x", exitCode: 0, passed: true, seconds: 0.1, tail: "" },
    {
      id: "bad",
      title: "Exits 3",
      command: "y",
      exitCode: 3,
      passed: false,
      seconds: 0.2,
      tail: "",
    },
  ]);
  expect(table).toMatch(/ok\s+\|\s+Exits 0\s+\|\s+pass/);
  expect(table).toMatch(/bad\s+\|\s+Exits 3\s+\|\s+FAIL/);
});
it("waits 10 minutes for a check that sets no time limit", () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
});
it("kills a check that runs longer than its timeoutMs and fails it", async () => {
  const started = Date.now();
  const [result] = await runChecks([
    {
      id: "slow",
      title: "Sleeps",
      command: node("console.log('started'); setTimeout(() => {}, 60000)"),
      timeoutMs: 200,
    },
  ]);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(result).toMatchObject({ id: "slow", passed: false, exitCode: null });
  expect(result.tail).toContain("started");
  expect(result.tail.split("\n").at(-1)).toBe("timed out after 0.2 s");
});
it("also kills the processes that a timed-out check started", async () => {
  const [result] = await runChecks([
    {
      id: "tree",
      title: "A child that keeps the output open",
      command: node(
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); console.log('child ' + c.pid); setTimeout(() => {}, 60000)",
      ),
      timeoutMs: 200,
    },
  ]);
  expect(result.tail.split("\n").at(-1)).toBe("timed out after 0.2 s");
  const pid = Number(/child (\d+)/.exec(result.tail)[1]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 20 && alive(); i++) await sleep(100);
  expect(alive()).toBe(false);
});
it("stops the running check when the caller aborts, and does not start the next one", async () => {
  const controller = new AbortController();
  const stop = sleep(200).then(() => controller.abort());
  const results = await runChecks(
    [
      {
        id: "slow",
        title: "Sleeps",
        command: node("console.log('started'); setTimeout(() => {}, 60000)"),
      },
      { id: "next", title: "Never starts", command: node("console.log('ran')") },
    ],
    { signal: controller.signal },
  );
  await stop;
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ id: "slow", passed: false, exitCode: null });
  expect(results[0].tail.split("\n").at(-1)).toBe("stopped by the caller");
  expect(results[1]).toMatchObject({ id: "next", passed: false, exitCode: null });
  expect(results[1].tail).toBe("stopped by the caller");
});
