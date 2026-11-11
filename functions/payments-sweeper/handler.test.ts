import type { LogEvent } from "@tc/core";
import type { SweepCounts } from "@tc/eps";
import { describe, expect, it } from "vitest";
import { createSweeperHandler } from "./handler";

const counts = (over: Partial<SweepCounts> = {}): SweepCounts => ({
  checked: 0,
  credited: 0,
  expired: 0,
  review: 0,
  unavailable: 0,
  ...over,
});

function setup(result: SweepCounts | Error, limit?: unknown) {
  const logs: LogEvent[] = [];
  const calls: unknown[][] = [];
  const handler = createSweeperHandler({
    sweep: async (...args: unknown[]) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
    log: (e) => logs.push(e),
    limit: limit as number | undefined,
  });
  return { handler, logs, calls };
}

describe("createSweeperHandler", () => {
  it("calls sweep once with the default limit and reports the counts", async () => {
    const { handler, calls } = setup(counts({ checked: 2, credited: 2 }));
    const report = await handler();
    expect(calls).toEqual([[{ limit: 25 }]]);
    expect(report).toEqual({
      checked: 2,
      credited: 2,
      expired: 0,
      review: 0,
      unavailable: 0,
      limit: 25,
      backlog: false,
      allUnavailable: false,
    });
  });

  it("flags a backlog when the batch fills", async () => {
    const { handler } = setup(counts({ checked: 10, credited: 10 }), 10);
    expect((await handler()).backlog).toBe(true);
  });

  it.each([0, 101, 1.5, Number.NaN, "5"])("falls back to 25 for limit %s", async (bad) => {
    const { handler, calls } = setup(counts(), bad);
    const report = await handler();
    expect(calls).toEqual([[{ limit: 25 }]]);
    expect(report.limit).toBe(25);
  });

  it("accepts the edges 1 and 100", async () => {
    expect((await setup(counts(), 1).handler()).limit).toBe(1);
    expect((await setup(counts(), 100).handler()).limit).toBe(100);
  });

  it("flags allUnavailable only when something was asked and nothing answered", async () => {
    expect((await setup(counts({ checked: 3, unavailable: 3 })).handler()).allUnavailable).toBe(
      true,
    );
    expect((await setup(counts({ checked: 0 })).handler()).allUnavailable).toBe(false);
    expect((await setup(counts({ checked: 3, unavailable: 2 })).handler()).allUnavailable).toBe(
      false,
    );
  });

  it("logs exactly one payments_sweep line with numbers and booleans only", async () => {
    const { handler, logs } = setup(counts({ checked: 4, review: 2, credited: 2 }));
    await handler();
    expect(logs).toHaveLength(1);
    const line = logs[0]!;
    expect(Object.keys(line).sort()).toEqual(
      [
        "allUnavailable",
        "backlog",
        "checked",
        "credited",
        "event",
        "expired",
        "limit",
        "review",
        "unavailable",
      ].sort(),
    );
    expect(line.event).toBe("payments_sweep");
    expect(line.review).toBe(2);
    for (const [k, v] of Object.entries(line)) {
      if (k !== "event") expect(["number", "boolean"]).toContain(typeof v);
    }
  });

  it("ignores the event completely", async () => {
    const hostile = { paymentId: "x", amount: 1, Records: [{ body: "hostile" }] };
    const results = [];
    for (const ev of [hostile, null, undefined]) {
      const { handler, calls } = setup(counts({ checked: 1, credited: 1 }));
      results.push(await handler(ev));
      expect(calls).toEqual([[{ limit: 25 }]]);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it("fails closed with a fixed message and never leaks the cause", async () => {
    const { handler, logs } = setup(new Error("secret-123"));
    await expect(handler()).rejects.toThrow(/^payments-sweeper: sweep failed$/);
    expect(logs).toEqual([{ event: "payments_sweep_failed", reason: "sweep_threw" }]);
    expect(JSON.stringify(logs)).not.toContain("secret-123");
    const err = await handler().catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("secret-123");
  });
});
