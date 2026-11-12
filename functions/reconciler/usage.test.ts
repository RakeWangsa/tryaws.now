import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "@tc/core";
import { fakeInventory } from "./fake-inventory";

// WPU-B3 (item 20): the reconciler writes the usage that the port reports through upsertUsage. The
// database is replaced here (the .db test of reconcile.test.ts needs PostgreSQL): this file proves what is
// written, what is dropped and that a failed write makes the run incomplete.

const ACCOUNT = "0198f0c0-0000-7000-8000-0000000000a1";
const R1 = {
  id: "0198f0c0-0000-7000-8000-000000000001",
  family: "linux_instance",
  region: "ap-south-1",
  awsName: "tc-instance-aaaaaaaaaaaaaaaa",
  state: "active",
  createdAt: new Date("2026-10-01T00:00:00Z"),
};
const h = vi.hoisted(() => ({ upsertUsage: vi.fn(async (...a: unknown[]) => void a.length) }));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  currentDatabaseUser: async () => "worker_rw",
  meteringRepo: () => ({ upsertUsage: h.upsertUsage }),
  reconcileRepo: () => ({
    activePoolAccounts: async () => [{ id: ACCOUNT }],
    resourcesOfAccount: async () => [R1],
    recordFinding: async () => true,
    capacityRows: async () => [],
    openOperations: async () => [],
  }),
}));

const { runReconcile } = await import("./reconcile");

const NOW = new Date("2026-11-13T09:30:00.000Z");
const logs: LogEvent[] = [];
const run = (usage: unknown) =>
  runReconcile({
    runTx: async (fn) => fn({} as never),
    port: fakeInventory({
      [ACCOUNT]: {
        items: [
          {
            region: "ap-south-1",
            family: "linux_instance",
            awsName: R1.awsName,
            state: "active",
            tagged: true,
          },
        ],
        live: [],
        usage: usage as never,
      },
    }),
    clock: { now: () => NOW },
    log: (e) => void logs.push(e),
  });

beforeEach(() => {
  logs.length = 0;
  h.upsertUsage.mockClear();
  h.upsertUsage.mockResolvedValue(undefined);
});

describe("runReconcile: usage", () => {
  it("writes the reported snapshot GB and transfer GB of a server, text quantities, by resource id", async () => {
    const result = await run([
      { awsName: R1.awsName, metric: "snapshot_gb", period: "2026-11-13", quantityGb: "40" },
      { awsName: R1.awsName, metric: "transfer_gb", period: "2026-11-13T14", quantityGb: "0.5" },
    ]);
    expect(h.upsertUsage.mock.calls).toEqual([
      [R1.id, "snapshot_gb", "2026-11-13", "40"],
      [R1.id, "transfer_gb", "2026-11-13T14", "0.5"],
    ]);
    expect(result).toMatchObject({ usageWritten: 2, usageSkipped: 0, usageFailed: 0 });
    expect(result.incomplete).toBe(false);
  });

  it("drops a bad sample, counts it and logs the reasons without any value", async () => {
    const result = await run([
      { awsName: R1.awsName, metric: "snapshot_gb", period: "2026-11-13", quantityGb: "-5" },
      {
        awsName: "tc-instance-zzzzzzzzzzzzzzzz",
        metric: "snapshot_gb",
        period: "2026-11-13",
        quantityGb: "5",
      },
    ]);
    expect(h.upsertUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ usageWritten: 0, usageSkipped: 2, usageFailed: 0 });
    const line = logs.find((l) => l.event === "reconcile_usage_skipped");
    expect(line).toMatchObject({ skipped: 2, reasons: "quantity,unmatched" });
    expect(JSON.stringify(logs)).not.toContain("-5");
  });

  it("writes nothing and asks nothing of the database when the port reports no usage", async () => {
    const result = await run(undefined);
    expect(h.upsertUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ usageWritten: 0, usageSkipped: 0, usageFailed: 0 });
  });

  it("fails closed: a write that throws makes the run incomplete and logs an alert, the rest of the run goes on", async () => {
    h.upsertUsage.mockRejectedValue(new Error("db down with secret detail"));
    const result = await run([
      { awsName: R1.awsName, metric: "snapshot_gb", period: "2026-11-13", quantityGb: "40" },
    ]);
    expect(result.usageFailed).toBe(1);
    expect(result.incomplete).toBe(true);
    expect(logs.find((l) => l.event === "reconcile_usage_failed")).toMatchObject({
      severity: "alert",
      poolAccountId: ACCOUNT,
    });
    expect(logs.find((l) => l.event === "reconcile_incomplete")).toBeDefined();
    expect(JSON.stringify(logs)).not.toContain("secret detail");
  });
});
