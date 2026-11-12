import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent } from "../operations/types";

// WPU-B3: a release that cannot give the units back leaves an audit row and one alert line, and a
// release that works leaves an audit row. The database calls are replaced: this file proves the
// decisions, the .db tests prove the SQL.

const h = vi.hoisted(() => ({
  inspect: vi.fn(),
  recordProblem: vi.fn(async () => undefined),
  mark: vi.fn(async () => true),
  lockCells: vi.fn(),
  setUsed: vi.fn(async () => undefined),
  insertAudit: vi.fn(async (...args: unknown[]) => String(args.length)),
}));
vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  capacityReleaseRepo: () => ({
    inspect: h.inspect,
    recordProblem: h.recordProblem,
    mark: h.mark,
  }),
  capacityRepo: () => ({ lockCells: h.lockCells, setUsed: h.setUsed }),
  insertAudit: h.insertAudit,
}));

const { RELEASE_PROBLEM_EVENT, releaseCapacity } = await import("./release");

const POOL = "0198f0c0-0000-7000-8000-0000000000a1";
const RESOURCE = "0198f0c0-0000-7000-8000-0000000000b2";
const clock = { now: () => new Date("2026-11-13T08:00:00.000Z") };
const tx = {} as never;
const goodRecord = {
  v: 1,
  poolAccountId: POOL,
  cells: [{ quotaCode: "instance_vcpu", region: "ap-south-1", amount: 2 }],
};
const logs: LogEvent[] = [];
const log = (e: LogEvent) => void logs.push(e);

beforeEach(() => {
  logs.length = 0;
  for (const fn of Object.values(h)) fn.mockClear();
  h.mark.mockResolvedValue(true);
});

describe("releaseCapacity: problems raise an alert and leave an audit row", () => {
  it("malformed_record: audit row, alert line with ids and a fixed reason only", async () => {
    h.inspect.mockResolvedValue({
      kind: "record",
      state: "failed",
      poolAccountId: POOL,
      record: { v: 2 },
    });
    const out = await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    expect(out).toEqual({ ok: true, value: { released: false, reason: "malformed_record" } });
    expect(h.recordProblem).toHaveBeenCalledWith(RESOURCE, "malformed_record");
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
    expect(h.insertAudit).toHaveBeenCalledWith(tx, {
      actorType: "system",
      actorId: null,
      action: "capacity.release_problem",
      targetType: "resource",
      targetId: RESOURCE,
      metadata: { reason: "malformed_record" },
    });
    expect(logs).toEqual([
      {
        event: RELEASE_PROBLEM_EVENT,
        severity: "alert",
        resourceId: RESOURCE,
        reason: "malformed_record",
      },
    ]);
  });

  it("row_missing: audit row and alert line, nothing is marked and nothing is lowered", async () => {
    h.inspect.mockResolvedValue({
      kind: "record",
      state: "destroyed",
      poolAccountId: POOL,
      record: goodRecord,
    });
    h.lockCells.mockResolvedValue([]);
    const out = await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    expect(out).toEqual({ ok: true, value: { released: false, reason: "row_missing" } });
    expect(h.mark).not.toHaveBeenCalled();
    expect(h.setUsed).not.toHaveBeenCalled();
    expect(h.insertAudit.mock.calls[0]?.[1]).toMatchObject({
      action: "capacity.release_problem",
      metadata: { reason: "row_missing" },
    });
    expect(logs.map((l) => [l.event, l.reason])).toEqual([[RELEASE_PROBLEM_EVENT, "row_missing"]]);
  });

  it("works without a logger (the audit row alone)", async () => {
    h.inspect.mockResolvedValue({
      kind: "record",
      state: "failed",
      poolAccountId: null,
      record: goodRecord,
    });
    await expect(releaseCapacity(tx, { resourceId: RESOURCE, clock })).resolves.toMatchObject({
      ok: true,
    });
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
  });
});

describe("releaseCapacity: a good release is audited and does not alert", () => {
  it("writes capacity.released with counts, no alert line", async () => {
    h.inspect.mockResolvedValue({
      kind: "record",
      state: "failed",
      poolAccountId: POOL,
      record: goodRecord,
    });
    h.lockCells.mockResolvedValue([
      {
        rowId: "r1",
        poolAccountId: POOL,
        region: "ap-south-1",
        quotaCode: "instance_vcpu",
        used: 1,
        quotaLimit: 4,
      },
    ]);
    const out = await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    expect(out.ok && out.value.released).toBe(true);
    expect(h.setUsed).toHaveBeenCalledTimes(1);
    expect(h.insertAudit.mock.calls[0]?.[1]).toMatchObject({
      action: "capacity.released",
      targetId: RESOURCE,
      metadata: { cells: 1, clamped: 1 },
    });
    expect(logs).toEqual([]);
  });

  it("is silent when the units were released before or the state is not final (no audit, no alert)", async () => {
    h.inspect.mockResolvedValueOnce({ kind: "none", reason: "already_released" });
    h.inspect.mockResolvedValueOnce({
      kind: "record",
      state: "active",
      poolAccountId: POOL,
      record: goodRecord,
    });
    await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    expect(h.insertAudit).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("does not audit a release that lost the race on the mark (already_released)", async () => {
    h.inspect.mockResolvedValue({
      kind: "record",
      state: "failed",
      poolAccountId: POOL,
      record: goodRecord,
    });
    h.lockCells.mockResolvedValue([
      {
        rowId: "r1",
        poolAccountId: POOL,
        region: "ap-south-1",
        quotaCode: "instance_vcpu",
        used: 2,
        quotaLimit: 4,
      },
    ]);
    h.mark.mockResolvedValue(false);
    const out = await releaseCapacity(tx, { resourceId: RESOURCE, clock, log });
    expect(out).toEqual({ ok: true, value: { released: false, reason: "already_released" } });
    expect(h.insertAudit).not.toHaveBeenCalled();
  });
});
