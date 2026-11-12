import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "../operations/types";

// WPU-B3 (item 21): the scheduler asks for the parameter list of each database once a day and for the
// state of each waiting certificate once an hour, by writing operation rows (R1). The repositories are
// replaced; the .db test proves the SQL.

const h = vi.hoisted(() => ({
  databasesToRead: vi.fn(),
  certificatesToRefresh: vi.fn(),
  insertOperation: vi.fn(),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  pollingRepo: () => ({
    databasesToRead: h.databasesToRead,
    certificatesToRefresh: h.certificatesToRefresh,
  }),
  insertOperation: h.insertOperation,
}));

const { DB_PARAMETERS_STALE_HOURS, runPolling } = await import("./polling");

const NOW = new Date("2026-11-13T09:30:00.000Z"); // 15:30 on 2026-11-13 in Dhaka
const id = (n: number) => `0198f0c0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const logs: LogEvent[] = [];
const sent: unknown[] = [];
const deps = {
  runTx: async <T>(fn: (tx: never) => Promise<T>) => fn({} as never),
  clock: { now: () => NOW },
  log: (e: LogEvent) => void logs.push(e),
  queue: { send: async (m: unknown) => void sent.push(m) },
};

beforeEach(() => {
  logs.length = 0;
  sent.length = 0;
  h.databasesToRead.mockReset().mockResolvedValue([]);
  h.certificatesToRefresh.mockReset().mockResolvedValue([]);
  h.insertOperation.mockReset().mockImplementation(async (_tx, input) => ({
    operationId: `op-${String(input.resourceId).slice(-3)}`,
    created: true,
    state: "queued",
    enqueueSeq: 0,
  }));
});

describe("runPolling", () => {
  it("queues read_db_parameters once for each database, keyed by the Dhaka day", async () => {
    h.databasesToRead.mockResolvedValueOnce([id(1), id(2)]).mockResolvedValue([]);
    const report = await runPolling(deps as never);
    expect(h.insertOperation.mock.calls.map((c) => c[1])).toEqual([
      {
        resourceId: id(1),
        kind: "read_db_parameters",
        payload: { source: "scheduler" },
        idempotencyKey: `poll:read-db-parameters:${id(1)}:2026-11-13`,
      },
      {
        resourceId: id(2),
        kind: "read_db_parameters",
        payload: { source: "scheduler" },
        idempotencyKey: `poll:read-db-parameters:${id(2)}:2026-11-13`,
      },
    ]);
    expect(report).toMatchObject({ databases: 2, certificates: 0, failed: 0 });
  });

  it("asks for databases last read more than a day ago", async () => {
    await runPolling(deps as never);
    const staleBefore = h.databasesToRead.mock.calls[0]?.[0] as Date;
    expect(DB_PARAMETERS_STALE_HOURS).toBe(24);
    expect(staleBefore.toISOString()).toBe("2026-11-12T09:30:00.000Z");
  });

  it("queues refresh_certificate once an hour for each waiting certificate, keyed by the hour", async () => {
    h.certificatesToRefresh.mockResolvedValueOnce([id(3)]).mockResolvedValue([]);
    const report = await runPolling(deps as never);
    expect(h.insertOperation.mock.calls[0]?.[1]).toEqual({
      resourceId: id(3),
      kind: "refresh_certificate",
      payload: { source: "scheduler" },
      idempotencyKey: `poll:refresh-certificate:${id(3)}:2026-11-13T09`,
    });
    expect(report.certificates).toBe(1);
  });

  it("counts a replay (the key exists) as already queued, not as new, and sends no message for it", async () => {
    h.databasesToRead.mockResolvedValueOnce([id(1)]).mockResolvedValue([]);
    h.insertOperation.mockResolvedValue({
      operationId: "op-x",
      created: false,
      state: "queued",
      enqueueSeq: 0,
    });
    const report = await runPolling(deps as never);
    expect(report).toMatchObject({ databases: 0, replayed: 1 });
    expect(sent).toEqual([]);
  });

  it("sends the first queue message after the row, only for a new queued operation", async () => {
    h.databasesToRead.mockResolvedValueOnce([id(1)]).mockResolvedValue([]);
    await runPolling(deps as never);
    expect(sent).toHaveLength(1);
  });

  it("does not send for an operation that waits for approval", async () => {
    h.certificatesToRefresh.mockResolvedValueOnce([id(3)]).mockResolvedValue([]);
    h.insertOperation.mockResolvedValue({
      operationId: "op-y",
      created: true,
      state: "needs_approval",
      enqueueSeq: 0,
    });
    await runPolling(deps as never);
    expect(sent).toEqual([]);
  });

  it("pages through the ids by the last id, and stops at the page limit", async () => {
    const page = Array.from({ length: 3 }, (_, i) => id(i + 1));
    h.databasesToRead.mockResolvedValue(page);
    await runPolling({ ...deps, pageSize: 3, maxPages: 2 } as never);
    expect(h.databasesToRead.mock.calls.map((c) => c[1])).toEqual([null, id(3)]);
  });

  it("isolates a failing resource: it is counted and logged by id, the next one still runs, the run does not throw", async () => {
    h.databasesToRead.mockResolvedValueOnce([id(1), id(2)]).mockResolvedValue([]);
    h.insertOperation.mockRejectedValueOnce(new TypeError("secret detail")).mockResolvedValueOnce({
      operationId: "op-2",
      created: true,
      state: "queued",
      enqueueSeq: 0,
    });
    const report = await runPolling(deps as never);
    expect(report).toMatchObject({ databases: 1, failed: 1 });
    expect(logs.find((l) => l.event === "poll_failed")).toMatchObject({
      kind: "read_db_parameters",
      resourceId: id(1),
      error: "TypeError",
    });
    expect(JSON.stringify(logs)).not.toContain("secret detail");
  });

  it("rejects the run when the list itself cannot be read (R16: a poll that cannot finish is not a pass)", async () => {
    h.databasesToRead.mockRejectedValue(new Error("db"));
    await expect(runPolling(deps as never)).rejects.toThrow("polling: the list could not be read");
  });

  it("works without a queue (the sweeper sends within minutes)", async () => {
    h.databasesToRead.mockResolvedValueOnce([id(1)]).mockResolvedValue([]);
    const noQueue = { runTx: deps.runTx, clock: deps.clock, log: deps.log };
    const report = await runPolling(noQueue as never);
    expect(report.databases).toBe(1);
    expect(sent).toEqual([]);
  });
});
