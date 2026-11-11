import type { CapacityCellRow } from "@tc/db";
import {
  ensureMarket,
  holdUntilWaiter,
  newCustomer,
  newResource,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  setResourceState,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { P1, P2, REGION, used } from "../test/capacity-helpers";
import { planRelease, releaseCapacity } from "./release";

const t = useTempDatabase();
const UNKNOWN = "00000000-0000-7000-8000-0000000000ff";
const NOW = "2026-11-11T08:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const RECORD = {
  v: 1,
  poolAccountId: P1,
  cells: [
    { quotaCode: "instance_vcpu", region: REGION, amount: 2 },
    { quotaCode: "static_ip", region: REGION, amount: 1 },
  ],
};
const pool = (vcpuUsed: number, ipUsed: number) =>
  seedPool(t.pool, {
    id: P1,
    cells: [
      { region: REGION, quotaCode: "instance_vcpu", limit: 4, used: vcpuUsed },
      { region: REGION, quotaCode: "static_ip", limit: 5, used: ipUsed },
    ],
  });
// The state is `failed` or `destroyed` when the failure step or the destroy step calls the release.
const resource = async (config: unknown, state = "failed") =>
  newResource(t.pool, await newCustomer(t.pool), {
    pool_account_id: P1,
    region: REGION,
    state,
    config: JSON.stringify(config),
  });
const release = (resourceId: string, role: "worker_rw" | "admin_rw" | "web_rw" = "worker_rw") =>
  runTransaction(t.db, (tx) => releaseCapacity(tx, { resourceId, clock }), { role });
const config = async (id: string) =>
  (await t.pool.query("select config from resources where id = $1", [id])).rows[0].config;
const problems = async (id: string) =>
  (
    await t.pool.query(
      "select kind, details from discrepancies where details ->> 'resourceId' = $1",
      [id],
    )
  ).rows;
const row = (quotaCode: CapacityCellRow["quotaCode"], used: number): CapacityCellRow => ({
  rowId: `row-${quotaCode}`,
  poolAccountId: P1,
  region: REGION,
  quotaCode,
  limit: 10,
  used,
  status: "active",
});

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("planRelease", () => {
  it("lowers used by the reserved amount and clamps at zero", () => {
    expect(
      planRelease([row("instance_vcpu", 5), row("static_ip", 0)], RECORD.cells as never),
    ).toEqual({
      changes: [
        { rowId: "row-instance_vcpu", used: 3, expectedUsed: 5 },
        { rowId: "row-static_ip", used: 0, expectedUsed: 0 },
      ],
      clamped: [RECORD.cells[1]],
      missing: [],
    });
  });
  it("gives nothing back for a certificate of the last 365 days", () => {
    expect(
      planRelease(
        [row("certificate_365d", 3)],
        [{ quotaCode: "certificate_365d", region: REGION, amount: 1 }],
      ),
    ).toEqual({ changes: [], clamped: [], missing: [] });
  });
  it("names the cells whose row is missing", () => {
    expect(planRelease([row("static_ip", 1)], RECORD.cells as never)).toMatchObject({
      missing: [RECORD.cells[0]],
    });
  });
});

describe("releaseCapacity", () => {
  it("gives the units of a failed create back once, and keeps the rest of the config", async () => {
    await pool(2, 1);
    const id = await resource({ bundle: "nano", capacityReservation: RECORD });
    expect(await release(id)).toEqual({
      ok: true,
      value: { released: true, cells: RECORD.cells, clamped: [] },
    });
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
    expect(await config(id)).toEqual({
      bundle: "nano",
      capacityReservation: { ...RECORD, releasedAt: NOW },
    });
    expect(await release(id)).toEqual({
      ok: true,
      value: { released: false, reason: "already_released" },
    });
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
  });
  it("gives the units back once when two releases run at the same moment", async () => {
    await pool(4, 3);
    const id = await resource({ capacityReservation: RECORD });
    // the release that takes the work keeps its locks until the other one really waits for them (no fixed sleep),
    // so the two transactions overlap
    let sawWaiter = false;
    const gated = () =>
      runTransaction(
        t.db,
        async (tx) => {
          const r = await releaseCapacity(tx, { resourceId: id, clock });
          if (r.ok && r.value.released) sawWaiter = (await holdUntilWaiter(tx, 5)) || sawWaiter;
          return r;
        },
        { role: "worker_rw" },
      );
    const both = await Promise.all([gated(), gated()]);
    expect(sawWaiter).toBe(true); // the second release waited for the first
    expect(both.map((r) => r.ok && r.value.released).sort()).toEqual([false, true]);
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 2));
  });
  it("does nothing for a resource with no record, and says not_found for an unknown id", async () => {
    await pool(2, 1);
    expect(await release(await resource({ bundle: "nano" }))).toEqual({
      ok: true,
      value: { released: false, reason: "no_reservation" },
    });
    expect(await release(await resource({ capacityReservation: null }))).toEqual({
      ok: true,
      value: { released: false, reason: "no_reservation" },
    });
    expect(await release(UNKNOWN)).toEqual({ ok: false, error: "not_found" });
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
  });
  it("keeps the units of a resource that is not failed or destroyed", async () => {
    await pool(2, 1);
    for (const state of ["creating", "active", "stopped", "suspended"]) {
      const id = await resource({ capacityReservation: RECORD }, state);
      expect(await release(id), state).toEqual({
        ok: true,
        value: { released: false, reason: "not_final" },
      });
      expect(await config(id)).toEqual({ capacityReservation: RECORD });
    }
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
  });
  it("takes the units back only if the transaction that holds the release commits", async () => {
    await pool(2, 1);
    const id = await resource({ capacityReservation: RECORD });
    await expect(
      runTransaction(
        t.db,
        async (tx) => {
          await releaseCapacity(tx, { resourceId: id, clock });
          throw new Error("the destroy failed after the release");
        },
        { role: "worker_rw" },
      ),
    ).rejects.toThrow("the destroy failed after the release");
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
    expect(await config(id)).toEqual({ capacityReservation: RECORD });
  });
  it("sets zero and names the cell when less is in use than was reserved", async () => {
    await pool(1, 1);
    const id = await resource({ capacityReservation: RECORD });
    expect(await release(id)).toEqual({
      ok: true,
      value: { released: true, cells: RECORD.cells, clamped: [RECORD.cells[0]] },
    });
    expect(await readUsed(t.pool, P1)).toEqual(used(0, 0));
  });
  it.each([
    ["a record that is a string", { capacityReservation: "x" }, "malformed_record"],
    [
      "cells that are not an array",
      { capacityReservation: { v: 1, poolAccountId: P1, cells: "x" } },
      "malformed_record",
    ],
    [
      "a quota code that does not exist",
      {
        capacityReservation: {
          v: 1,
          poolAccountId: P1,
          cells: [{ quotaCode: "gpu", region: REGION, amount: 1 }],
        },
      },
      "malformed_record",
    ],
    [
      "an amount above the maximum",
      {
        capacityReservation: {
          v: 1,
          poolAccountId: P1,
          cells: [{ quotaCode: "static_ip", region: REGION, amount: 2_000_000 }],
        },
      },
      "malformed_record",
    ],
    [
      "a record of another account",
      { capacityReservation: { ...RECORD, poolAccountId: P2 } },
      "malformed_record",
    ],
    [
      "a cell that has no pool_capacity row",
      {
        capacityReservation: {
          v: 1,
          poolAccountId: P1,
          cells: [{ quotaCode: "database", region: REGION, amount: 1 }],
        },
      },
      "row_missing",
    ],
  ])(
    "does not throw and does not undo the refund for %s: it answers released:false and opens a discrepancy",
    async (_, bad, reason) => {
      await pool(2, 1);
      await seedPool(t.pool, {
        id: P2,
        cells: [{ region: REGION, quotaCode: "static_ip", limit: 5, used: 3 }],
      });
      const id = await resource(bad, "creating");
      // the failure step: the state change creating -> failed (a real write that must commit), then the release, in one transaction
      const answer = await runTransaction(
        t.db,
        async (tx) => {
          await setResourceState(tx, id, "failed");
          return releaseCapacity(tx, { resourceId: id, clock });
        },
        { role: "worker_rw" },
      );
      expect(answer).toEqual({ ok: true, value: { released: false, reason } });
      expect(
        (await t.pool.query("select state from resources where id = $1", [id])).rows[0].state,
      ).toBe("failed"); // the transaction committed
      expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
      expect((await readUsed(t.pool, P2))[`${REGION}/static_ip`]).toBe(3);
      expect((await config(id)).capacityReservation?.releasedAt).toBeUndefined();
      expect(await problems(id)).toEqual([
        { kind: "missing", details: { resourceId: id, reason, source: "capacity_release" } },
      ]);
    },
  );
  it("is refused for admin_rw and web_rw, which may change neither used nor resources", async () => {
    await pool(2, 1);
    const id = await resource({ capacityReservation: RECORD });
    for (const role of ["admin_rw", "web_rw"] as const) {
      await expect(release(id, role)).rejects.toMatchObject({ name: "DbError", code: "42501" });
    }
    expect(await readUsed(t.pool, P1)).toEqual(used(2, 1));
  });
});
