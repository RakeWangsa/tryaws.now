import { expect, it } from "vitest";
import { MAX_WAIT_SECONDS, checkStepResult, stepDone, stepNext, stepWait } from "./steps";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

it("the constructors build frozen results", () => {
  expect(Object.isFrozen(stepNext("wait_running"))).toBe(true);
  expect(stepDone({ state: "active" })).toEqual({ kind: "done", patch: { state: "active" } });
  expect(stepWait("poll", at(30))).toEqual({ kind: "wait", step: "poll", until: at(30) });
});

it("checkStepResult accepts next, wait and done and returns frozen copies", () => {
  const input = {
    kind: "next",
    step: "allocate_ip",
    patch: {
      state: "creating",
      awsName: "tc-instance-0123456789abcdef",
      configMerge: { ports: [22] },
    },
  };
  const out = checkStepResult(input, NOW);
  expect(out).toEqual(input);
  expect(out).not.toBe(input);
  expect(Object.isFrozen(out)).toBe(true);
  expect(checkStepResult({ kind: "done" }, NOW)).toEqual({ kind: "done" });
});

it("until is clamped into [now, now + 86400 seconds]", () => {
  expect(MAX_WAIT_SECONDS).toBe(86_400);
  expect(checkStepResult({ kind: "wait", step: "poll", until: at(-500) }, NOW)).toEqual({
    kind: "wait",
    step: "poll",
    until: NOW,
  });
  expect(
    checkStepResult({ kind: "wait", step: "poll", until: new Date("2099-01-01T00:00:00Z") }, NOW),
  ).toEqual({ kind: "wait", step: "poll", until: at(86_400) });
});

it.each([
  ["not an object", "next"],
  ["null", null],
  ["unknown kind", { kind: "later", step: "a" }],
  ["empty step", { kind: "next", step: "" }],
  ["upper case step", { kind: "next", step: "Wait" }],
  ["step with a space", { kind: "next", step: "a b" }],
  ["step of 41 characters", { kind: "next", step: "a".repeat(41) }],
  ["wait without until", { kind: "wait", step: "a" }],
  ["wait with an invalid date", { kind: "wait", step: "a", until: new Date(Number.NaN) }],
  ["wait with a string date", { kind: "wait", step: "a", until: "2030-01-01" }],
  ["unknown patch key", { kind: "done", patch: { deletedAt: new Date() } }],
  ["unknown resource state", { kind: "done", patch: { state: "gone" } }],
  ["aws name outside R11", { kind: "done", patch: { awsName: "my-server" } }],
  ["aws name with an unknown type", { kind: "done", patch: { awsName: "tc-vm-0123456789abcdef" } }],
  [
    "aws name with 15 hex digits",
    { kind: "done", patch: { awsName: "tc-instance-0123456789abcde" } },
  ],
  ["config merge as an array", { kind: "done", patch: { configMerge: [1] } }],
  ["config merge over 16 KiB", { kind: "done", patch: { configMerge: { x: "a".repeat(16_400) } } }],
  ["config merge with a bigint", { kind: "done", patch: { configMerge: { x: 1n } } }],
  ["config merge with a password key", { kind: "done", patch: { configMerge: { password: "x" } } }],
  ["config merge with a token key", { kind: "done", patch: { configMerge: { apiToken: "x" } } }],
])("rejects %s", (_name, value) => {
  expect(checkStepResult(value, NOW)).toBeNull();
});
