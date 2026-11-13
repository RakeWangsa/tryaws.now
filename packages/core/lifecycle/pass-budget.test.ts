import type { CandidateKey, LifecycleRow, Tx } from "@tc/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueMessage } from "../operations/queue";
import type { LogEvent, RunTx } from "../operations/types";
import type { Clock } from "../types";

// WPU-Z12 review. The lifecycle pass has an upper bound in time: a deadline read from the injected clock between rows,
// LIFECYCLE_BUDGET_MS by default. Walking every candidate with no deadline could take longer than the scheduler's run
// (55 s) and starve the jobs after it in the same run (metering, static IPs, unpaid, invoices, rate watch). Without a
// database: the repositories are replaced (as in polling.test.ts). Every row is a retained subscription whose resource
// is not destroyed yet, so the pass queues its destroy and sends one message; a row "takes" its time when it is read
// under its lock. The same pass on PostgreSQL: candidate-walk.db.test.ts.

const h = vi.hoisted(() => ({
  readSettings: vi.fn(),
  listCandidates: vi.fn(),
  lock: vi.fn(),
  insertOperation: vi.fn(),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  lifecycleRepo: () => ({
    readSettings: h.readSettings,
    listCandidates: h.listCandidates,
    lock: h.lock,
  }),
  insertOperation: h.insertOperation,
}));

const { LIFECYCLE_BUDGET_MS, LifecyclePassCutError, runLifecycle } = await import("./engine");

const START = new Date("2026-11-13T06:00:00.000Z");
const SECOND = 1000;
const END = "2026-10-01T06:00:00.000000Z";
const hex = (n: number) => n.toString(16).padStart(12, "0");
const subscriptionId = (n: number) => `0190aaaa-0000-7000-8000-${hex(n)}`;
const resourceId = (n: number) => `0190bbbb-0000-7000-8000-${hex(n)}`;
const keyOf = (n: number): CandidateKey => ({ id: subscriptionId(n), periodEnd: END });
const numberOf = (id: string) => Number.parseInt(id.slice(-12), 16);

// A retained subscription whose resource still exists: the pass queues its destroy (ensure_retention_operations).
const rowOf = (id: string): LifecycleRow => ({
  id,
  resourceId: resourceId(numberOf(id)),
  customerId: "0190cccc-0000-7000-8000-000000000001",
  market: "BD",
  termDays: 30,
  priceSnapshot: {},
  periodStart: new Date("2026-09-01T06:00:00.000Z"),
  periodEnd: new Date(END),
  autoRenew: false,
  status: "retained",
  resource: { family: "load_balancer", state: "suspended", config: {}, deletedAt: null },
});

let list: CandidateKey[] = [];
let elapsed = 0;
let events: string[] = [];
let pageReads: (CandidateKey | null)[] = [];
let logs: LogEvent[] = [];
let failing = new Set<string>();
const inserted = new Set<string>();

const clock: Clock = { now: () => new Date(START.getTime() + elapsed) };
const runTx: RunTx = (fn) => fn({} as Tx);
const queue = {
  send: async (message: QueueMessage) => void events.push(`send ${message.resourceId}`),
};
const deps = (extra: { budgetMs?: number; clock?: Clock } = {}) => ({
  runTx,
  clock,
  log: (e: LogEvent) => void logs.push(e),
  queue,
  pageSize: 8,
  ...extra,
});
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => keyOf(from + i));
const lockedIds = () =>
  events.filter((e) => e.startsWith("lock ")).map((e) => e.slice("lock ".length));
const sentResources = () =>
  events.filter((e) => e.startsWith("send ")).map((e) => e.slice("send ".length));
const NO_STEP = { reminded: 0, renewed: 0, graced: 0, retained: 0, ended: 0 };

beforeEach(() => {
  list = [];
  elapsed = 0;
  events = [];
  pageReads = [];
  logs = [];
  failing = new Set();
  inserted.clear();
  h.readSettings.mockReset().mockResolvedValue(new Map());
  h.listCandidates
    .mockReset()
    .mockImplementation(
      async (_now: Date, _horizon: number, limit: number, after: CandidateKey | null) => {
        pageReads.push(after);
        const from = after === null ? 0 : list.findIndex((k) => k.id === after.id) + 1;
        return list.slice(from, from + limit);
      },
    );
  // Each row takes one second. A row in `failing` throws once its second is used.
  h.lock.mockReset().mockImplementation(async (id: string) => {
    events.push(`lock ${id}`);
    elapsed += SECOND;
    if (failing.has(id)) throw new TypeError("the row cannot be read");
    return rowOf(id);
  });
  // One operation per key: a repeat is the stored row again, no message (R7).
  h.insertOperation
    .mockReset()
    .mockImplementation(async (_tx: Tx, input: { resourceId: string; idempotencyKey: string }) => {
      const created = !inserted.has(input.idempotencyKey);
      inserted.add(input.idempotencyKey);
      return {
        operationId: `op-${input.resourceId}`,
        created,
        state: "queued",
        enqueueSeq: 0,
      };
    });
});

describe("the time budget of the lifecycle pass (WPU-Z12 review)", () => {
  it("is 20 s by default: about a third of the scheduler's 55 s run, the rest is for the jobs after it", () => {
    expect(LIFECYCLE_BUDGET_MS).toBe(20_000);
  });

  it("a pass that runs out of time stops between rows, has sent what it did, logs one line and fails (R16)", async () => {
    list = rows(1, 50);
    const pass = runLifecycle(deps());
    await expect(pass).rejects.toThrow(LifecyclePassCutError);
    // one second a row: the rows that started before 20 s, none after
    expect(lockedIds()).toEqual(rows(1, 20).map((k) => k.id));
    expect(sentResources()).toEqual(rows(1, 20).map((k) => resourceId(numberOf(k.id))));
    // pages of 8: rows 1 to 8, 9 to 16, 17 to 24; no page is read after the cut
    expect(pageReads).toEqual([null, keyOf(8), keyOf(16)]);
    // counts and fixed words only (R14)
    expect(logs).toEqual([
      {
        event: "lifecycle_pass_cut",
        budgetMs: 20_000,
        examined: 20,
        ...NO_STEP,
        failed: 0,
      },
    ]);
  });

  it("the error names no row and no time (R14), so the scheduler logs only its name", async () => {
    list = rows(1, 30);
    const error = await runLifecycle(deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LifecyclePassCutError);
    expect((error as Error).name).toBe("LifecyclePassCutError");
    expect((error as Error).message).toBe(
      "lifecycle: the pass reached its time budget before the end of the candidate list",
    );
  });

  it("the message of a row is sent after its commit and before the next row starts, so the deadline covers the sends", async () => {
    list = rows(1, 3);
    await runLifecycle(deps());
    expect(events).toEqual([
      `lock ${subscriptionId(1)}`,
      `send ${resourceId(1)}`,
      `lock ${subscriptionId(2)}`,
      `send ${resourceId(2)}`,
      `lock ${subscriptionId(3)}`,
      `send ${resourceId(3)}`,
    ]);
  });

  it("a pass inside its budget returns its report and logs no cut", async () => {
    list = rows(1, 5);
    expect(await runLifecycle(deps())).toEqual({ examined: 5, ...NO_STEP, failed: 0 });
    expect(sentResources()).toHaveLength(5);
    expect(logs).toEqual([]);
  });

  it("budgetMs moves the deadline; a row that fails uses its time, is counted, and the walk goes on", async () => {
    list = rows(1, 10);
    failing = new Set([subscriptionId(2)]);
    await expect(runLifecycle(deps({ budgetMs: 3_500 }))).rejects.toThrow(LifecyclePassCutError);
    // asked at 0, 1, 2 and 3 s: four rows; at 4 s the budget of 3.5 s is used up
    expect(lockedIds()).toEqual(rows(1, 4).map((k) => k.id));
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "lifecycle",
        action: "error",
        subscriptionId: subscriptionId(2),
      }),
    );
    expect(logs.at(-1)).toEqual({
      event: "lifecycle_pass_cut",
      budgetMs: 3_500,
      examined: 4,
      ...NO_STEP,
      failed: 1,
    });
  });

  it("the next pass starts at the head again; the rows the first one did are replays and only the rest is sent (R7)", async () => {
    list = rows(1, 10);
    await expect(runLifecycle(deps({ budgetMs: 3_500 }))).rejects.toThrow(LifecyclePassCutError);
    expect(sentResources()).toEqual(rows(1, 4).map((k) => resourceId(numberOf(k.id))));
    events = [];
    pageReads = [];
    expect(await runLifecycle(deps({ budgetMs: 60_000 }))).toEqual({
      examined: 10,
      ...NO_STEP,
      failed: 0,
    });
    expect(pageReads[0]).toBeNull();
    expect(lockedIds()).toEqual(rows(1, 10).map((k) => k.id));
    expect(sentResources()).toEqual(rows(5, 10).map((k) => resourceId(numberOf(k.id))));
  });

  it("a budget that is not a positive number of milliseconds is refused before anything is read (R16)", async () => {
    list = rows(1, 3);
    for (const budgetMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      await expect(runLifecycle(deps({ budgetMs }))).rejects.toThrow(RangeError);
    }
    expect(h.readSettings).not.toHaveBeenCalled();
    expect(h.listCandidates).not.toHaveBeenCalled();
    expect(h.lock).not.toHaveBeenCalled();
  });

  it("a clock that cannot be read between rows is past the deadline (R16): no row starts", async () => {
    list = rows(1, 3);
    let readings = 0;
    const unreadable: Clock = {
      now: () => (readings++ === 0 ? START : new Date(Number.NaN)),
    };
    await expect(runLifecycle(deps({ clock: unreadable }))).rejects.toThrow(LifecyclePassCutError);
    expect(h.lock).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: "lifecycle_pass_cut", budgetMs: 20_000, examined: 0, ...NO_STEP, failed: 0 },
    ]);
  });
});
