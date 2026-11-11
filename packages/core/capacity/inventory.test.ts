import {
  ensureMarket,
  newCustomer,
  newResource,
  readUsed,
  resetCapacity,
  runTransaction,
  seedPool,
  useTempDatabase,
  type DatabaseRole,
} from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { P1, P2, REGION } from "../test/capacity-helpers";
import { correctedUsed, recomputeUsed } from "./inventory";

const t = useTempDatabase();
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
const cells = [
  { region: REGION, quotaCode: "instance_vcpu" as const, limit: 40, used: 9 },
  { region: REGION, quotaCode: "static_ip" as const, limit: 5, used: 1 },
];
const resource = async (pool: string, config: unknown, state = "creating") =>
  newResource(t.pool, await newCustomer(t.pool), {
    pool_account_id: pool,
    region: REGION,
    state,
    config: JSON.stringify(config),
  });
const recompute = (
  role: DatabaseRole,
  over: { quotaCode?: "instance_vcpu" | "static_ip" | "database"; live?: number } = {},
) =>
  runTransaction(
    t.db,
    (tx) =>
      recomputeUsed(tx, {
        poolAccountId: P1,
        region: REGION,
        quotaCode: "instance_vcpu",
        live: 2,
        clock,
        ...over,
      }),
    { role },
  );

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("correctedUsed", () => {
  it("is the live count plus the units reserved for creates that have not succeeded", () => {
    expect(correctedUsed(2, 3)).toBe(5);
    expect(correctedUsed(0, 0)).toBe(0);
    for (const [live, pending] of [
      [-1, 0],
      [1, 0.5],
      [Number.NaN, 0],
    ] as const) {
      expect(() => correctedUsed(live, pending)).toThrow(RangeError);
    }
  });
});

describe("recomputeUsed", () => {
  it("sets used to the live count plus the units of creates that have not succeeded, and drops a leak", async () => {
    await seedPool(t.pool, { id: P1, cells });
    await seedPool(t.pool, { id: P2, cells });
    await resource(P1, { capacityReservation: RECORD }); // creating: pending 2
    await resource(P1, { capacityReservation: RECORD }); // creating: 2 more
    await resource(P1, { capacityReservation: RECORD }, "failed"); // a leak: not pending
    await resource(P1, { capacityReservation: RECORD }, "active"); // live: part of the live count, not pending
    await resource(P1, { capacityReservation: { ...RECORD, releasedAt: NOW } }); // released: not pending
    await resource(P1, { bundle: "nano" }); // no record: not pending
    await resource(P2, { capacityReservation: RECORD }); // another account: not counted here
    expect(await recompute("worker_rw")).toEqual({ used: 6, previous: 9, pending: 4 });
    expect(await readUsed(t.pool, P1)).toEqual({
      [`${REGION}/instance_vcpu`]: 6,
      [`${REGION}/static_ip`]: 1,
    });
    expect(await readUsed(t.pool, P2)).toEqual({
      [`${REGION}/instance_vcpu`]: 9,
      [`${REGION}/static_ip`]: 1,
    });
    const { rows } = await t.pool.query(
      "select quota_code, checked_at from pool_capacity where pool_account_id = $1 order by quota_code",
      [P1],
    );
    expect(rows.map((r) => [r.quota_code, r.checked_at?.toISOString() ?? null])).toEqual([
      ["instance_vcpu", NOW],
      ["static_ip", null],
    ]);
    expect(await recompute("worker_rw", { quotaCode: "static_ip", live: 0 })).toEqual({
      used: 2,
      previous: 1,
      pending: 2,
    });
  });
  it("counts certificate_365d from the platform's own records: the last 365 days, any state but creating, released or not, and adds the creates in flight", async () => {
    const cert = [
      { region: "us-east-1", quotaCode: "certificate_365d" as const, limit: 20, used: 7 },
    ];
    await seedPool(t.pool, { id: P1, cells: cert });
    await seedPool(t.pool, { id: P2, cells: cert });
    const CERT = {
      v: 1,
      poolAccountId: P1,
      cells: [{ quotaCode: "certificate_365d", region: "us-east-1", amount: 1 }],
    };
    // resources_deleted_check: a destroyed resource has a deleted_at, any other state has none
    const at = async (pool: string, config: unknown, state: string, created_at: string) =>
      newResource(t.pool, await newCustomer(t.pool), {
        pool_account_id: pool,
        region: "us-east-1",
        state,
        config: JSON.stringify(config),
        created_at,
        ...(state === "destroyed" ? { deleted_at: "2026-06-02T00:00:00Z" } : {}),
      });
    await at(P1, { capacityReservation: CERT }, "active", "2026-10-01T00:00:00Z"); // counted
    await at(
      P1,
      { capacityReservation: { ...CERT, releasedAt: NOW } },
      "destroyed",
      "2026-06-01T00:00:00Z",
    ); // counted: a deleted certificate still counts
    await at(P1, { capacityReservation: CERT }, "active", "2025-09-01T00:00:00Z"); // older than 365 days
    await at(P1, { capacityReservation: CERT }, "creating", "2026-11-10T00:00:00Z"); // pending, not counted twice
    await at(
      P2,
      { capacityReservation: { ...CERT, poolAccountId: P2 } },
      "active",
      "2026-10-01T00:00:00Z",
    ); // another account
    const outcome = await runTransaction(
      t.db,
      (tx) =>
        recomputeUsed(tx, {
          poolAccountId: P1,
          region: "us-east-1",
          quotaCode: "certificate_365d",
          live: 0,
          clock,
        }),
      { role: "worker_rw" },
    );
    expect(outcome).toEqual({ used: 3, previous: 7, pending: 1 });
    expect((await readUsed(t.pool, P2))["us-east-1/certificate_365d"]).toBe(7);
  });
  it("can set used above the limit when the live count is above it", async () => {
    await seedPool(t.pool, { id: P1, cells });
    expect(await recompute("worker_rw", { live: 45 })).toEqual({
      used: 45,
      previous: 9,
      pending: 0,
    });
  });
  it("fails closed when the row does not exist, and for a live count that is not a count", async () => {
    await seedPool(t.pool, { id: P1, cells });
    await expect(recompute("worker_rw", { quotaCode: "database" })).rejects.toThrow(
      "capacity: the row to correct does not exist",
    );
    await expect(recompute("worker_rw", { live: -1 })).rejects.toThrow(RangeError);
    expect((await readUsed(t.pool, P1))[`${REGION}/instance_vcpu`]).toBe(9);
  });
  it("is refused for admin_rw and web_rw, which may not write checked_at", async () => {
    await seedPool(t.pool, { id: P1, cells });
    for (const role of ["admin_rw", "web_rw"] as const) {
      await expect(recompute(role)).rejects.toMatchObject({ name: "DbError", code: "42501" });
    }
  });
});
