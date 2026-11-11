import { readFileSync } from "node:fs";
import { OPERATION_STATES } from "@tc/db";
import { expect, it } from "vitest";
import {
  ADMIN_TRANSITIONS,
  INSERT_STATES,
  WORKER_TRANSITIONS,
  WRITABLE_COLUMNS,
  assertTransition,
  canTransition,
  isFinal,
} from "./states";

it("the worker moves an operation through exactly these eleven transitions", () => {
  expect(WORKER_TRANSITIONS).toEqual([
    ["queued", "running"],
    ["queued", "waiting"],
    ["queued", "needs_attention"],
    ["queued", "queued"],
    ["waiting", "queued"],
    ["running", "queued"],
    ["running", "waiting"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "needs_attention"],
    ["needs_attention", "failed"],
  ]);
});

it("an admin moves an operation through exactly these three, and never from needs_attention to failed (that move skips the refund of 10.1)", () => {
  expect(ADMIN_TRANSITIONS).toEqual([
    ["needs_approval", "queued"],
    ["needs_approval", "failed"],
    ["needs_attention", "queued"],
  ]);
  expect(canTransition("admin", "needs_attention", "failed")).toBe(false);
  expect(canTransition("worker", "needs_attention", "failed")).toBe(true);
});

it("every state is reachable from an insert state, and a final state leads nowhere", () => {
  const edges = [...WORKER_TRANSITIONS, ...ADMIN_TRANSITIONS];
  const reached = new Set<string>([
    ...INSERT_STATES.web,
    ...INSERT_STATES.worker,
    ...INSERT_STATES.admin,
  ]);
  for (let round = 0; round < OPERATION_STATES.length; round++) {
    for (const [from, to] of edges) if (reached.has(from)) reached.add(to);
  }
  expect([...reached].sort()).toEqual([...OPERATION_STATES].sort());
  for (const state of OPERATION_STATES.filter(isFinal)) {
    expect(edges.filter(([from]) => from === state)).toEqual([]);
  }
  expect(OPERATION_STATES.filter(isFinal)).toEqual(["succeeded", "failed"]);
});

it("only the admin leaves needs_approval, only the admin retries a needs_attention operation, and nobody leaves a final state", () => {
  expect(canTransition("worker", "needs_attention", "queued")).toBe(false);
  expect(canTransition("worker", "needs_approval", "queued")).toBe(false);
  expect(canTransition("admin", "needs_attention", "queued")).toBe(true);
  expect(canTransition("admin", "queued", "running")).toBe(false);
  expect(canTransition("worker", "succeeded", "queued")).toBe(false);
  expect(canTransition("admin", "failed", "queued")).toBe(false);
});

it("assertTransition names the states and the actor and nothing else", () => {
  expect(() => assertTransition("worker", "succeeded", "queued")).toThrow(
    "operation: illegal transition succeeded -> queued by worker",
  );
  expect(() => assertTransition("worker", "running", "succeeded")).not.toThrow();
});

it("the columns each role may write are the columns of grants.expected.json", () => {
  const cell = JSON.parse(
    readFileSync(new URL("../../db/test/grants.expected.json", import.meta.url), "utf8"),
  ).operations;
  expect([...WRITABLE_COLUMNS.worker].sort()).toEqual([...cell.worker_rw.updateColumns].sort());
  expect([...WRITABLE_COLUMNS.admin].sort()).toEqual([...cell.admin_rw.updateColumns].sort());
  expect(cell.web_rw.updateColumns).toBeNull();
  expect(WRITABLE_COLUMNS.web).toEqual([]);
  expect(cell.web_rw.insertColumns).toContain("needs_approval");
  expect(cell.worker_rw.insertColumns).toContain("needs_approval");
  expect(cell.admin_rw.insertColumns).not.toContain("needs_approval");
  expect(INSERT_STATES.admin).toEqual(["queued"]);
});
