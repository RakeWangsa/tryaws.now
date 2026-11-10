import { expect, it } from "vitest";
import { formatTable, runChecks } from "./verify-runner.mjs";

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
