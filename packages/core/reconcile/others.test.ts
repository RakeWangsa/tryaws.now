import { describe, expect, it } from "vitest";
import { planCapacityChecks } from "./capacity";
import { dayKeyOf, findingId } from "./ids";
import { staleOperations, type OpRow } from "./stale";

describe("planCapacityChecks", () => {
  const rows = [
    { rowId: "r1", region: "ap-southeast-1", quotaCode: "instance_vcpu", used: 4, quotaLimit: 20 },
    { rowId: "r2", region: "ap-southeast-1", quotaCode: "static_ip", used: 1, quotaLimit: 5 },
    {
      rowId: "r3",
      region: "ap-southeast-1",
      quotaCode: "certificate_365d",
      used: 2,
      quotaLimit: 10,
    },
    { rowId: "r4", region: "global", quotaCode: "bucket", used: 9, quotaLimit: 5 },
  ];

  it("checks the cells that have a live count; certificate_365d needs none and gets 0", () => {
    const plan = planCapacityChecks(rows, [
      { region: "ap-southeast-1", quotaCode: "instance_vcpu", live: 6 },
      { region: "global", quotaCode: "bucket", live: 3 },
    ]);
    expect(plan.checks).toEqual([
      { region: "ap-southeast-1", quotaCode: "instance_vcpu", live: 6 },
      { region: "ap-southeast-1", quotaCode: "certificate_365d", live: 0 },
      { region: "global", quotaCode: "bucket", live: 3 },
    ]);
  });

  it("a cell with no live count is skipped and reported, never read as zero (R16)", () => {
    const plan = planCapacityChecks(rows, []);
    expect(plan.skipped).toEqual([
      { region: "ap-southeast-1", quotaCode: "instance_vcpu" },
      { region: "ap-southeast-1", quotaCode: "static_ip" },
      { region: "global", quotaCode: "bucket" },
    ]);
  });

  it("ignores a live count for a cell the database does not know", () => {
    const plan = planCapacityChecks(rows, [
      { region: "us-east-1", quotaCode: "database", live: 1 },
    ]);
    expect(plan.checks.map((c) => c.quotaCode)).toEqual(["certificate_365d"]);
  });

  it("rejects a negative or fractional live count", () => {
    expect(() =>
      planCapacityChecks(rows, [{ region: "global", quotaCode: "bucket", live: -1 }]),
    ).toThrow(RangeError);
    expect(() =>
      planCapacityChecks(rows, [{ region: "global", quotaCode: "bucket", live: 1.5 }]),
    ).toThrow(RangeError);
  });
});

describe("staleOperations", () => {
  const NOW = new Date("2026-11-12T12:00:00Z");
  const op = (over: Partial<OpRow> = {}): OpRow => ({
    id: "o1",
    resourceId: "res1",
    kind: "create",
    state: "running",
    attempts: 1,
    nextRunAt: new Date("2026-11-12T11:59:00Z"),
    createdAt: new Date("2026-11-12T11:00:00Z"),
    ...over,
  });

  it("an operation due a minute ago is not stale", () => {
    expect(staleOperations([op()], NOW)).toEqual([]);
  });

  it("queued, running and waiting past the limit are stale, with the age", () => {
    for (const state of ["queued", "running", "waiting"]) {
      const out = staleOperations(
        [op({ state, nextRunAt: new Date("2026-11-12T08:00:00Z") })],
        NOW,
      );
      expect(out).toEqual([
        {
          operationId: "o1",
          resourceId: "res1",
          kind: "create",
          state,
          attempts: 1,
          ageMs: 4 * 3_600_000,
        },
      ]);
    }
  });

  it("needs_attention is stale after a day, by its creation time", () => {
    const fresh = op({ state: "needs_attention", createdAt: new Date("2026-11-12T00:00:00Z") });
    const old = op({ state: "needs_attention", createdAt: new Date("2026-11-10T12:00:00Z") });
    expect(staleOperations([fresh], NOW)).toEqual([]);
    expect(staleOperations([old], NOW)).toHaveLength(1);
  });

  it("terminal states and needs_approval are never stale", () => {
    const ancient = new Date("2026-01-01T00:00:00Z");
    for (const state of ["succeeded", "failed", "needs_approval"]) {
      expect(staleOperations([op({ state, nextRunAt: ancient, createdAt: ancient })], NOW)).toEqual(
        [],
      );
    }
  });
});

describe("findingId and dayKeyOf", () => {
  it("is a stable UUID for the same day, kind and subject, and differs when any changes", () => {
    const a = findingId("2026-11-12", "orphan", "tc-instance-aaaaaaaaaaaaaaaa");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(findingId("2026-11-12", "orphan", "tc-instance-aaaaaaaaaaaaaaaa")).toBe(a);
    expect(findingId("2026-11-13", "orphan", "tc-instance-aaaaaaaaaaaaaaaa")).not.toBe(a);
    expect(findingId("2026-11-12", "missing", "tc-instance-aaaaaaaaaaaaaaaa")).not.toBe(a);
    expect(findingId("2026-11-12", "orphan", "tc-instance-bbbbbbbbbbbbbbbb")).not.toBe(a);
  });

  it("the day key is the Dhaka day (UTC+6)", () => {
    expect(dayKeyOf(new Date("2026-11-11T17:59:59Z"))).toBe("2026-11-11");
    expect(dayKeyOf(new Date("2026-11-11T18:00:00Z"))).toBe("2026-11-12");
  });

  it("refuses a malformed day key", () => {
    expect(() => findingId("12-11-2026", "orphan", "x")).toThrow(TypeError);
  });
});
