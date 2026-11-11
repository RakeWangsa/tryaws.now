import { beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { capacityRepo, type CellKey } from "../repositories/capacity";
import { holdUntilWaiter, readUsed, resetCapacity, seedPool } from "../testing/capacity";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const [P1, P2, P3] = [
  "00000000-0000-7000-8000-000000000001",
  "00000000-0000-7000-8000-000000000002",
  "00000000-0000-7000-8000-000000000003",
];
const CELLS: readonly CellKey[] = [
  { region: REGION, quotaCode: "instance_vcpu" },
  { region: REGION, quotaCode: "static_ip" },
];
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
const seedThree = async () => {
  const p1 = await seedPool(t.pool, {
    id: P1,
    tier: "new",
    cells: [
      { region: REGION, quotaCode: "instance_vcpu", limit: 4, used: 1 },
      { region: REGION, quotaCode: "static_ip", limit: 5 },
      { region: "us-east-1", quotaCode: "static_ip", limit: 5 },
    ],
  });
  const p2 = await seedPool(t.pool, {
    id: P2,
    tier: "trusted",
    cells: [{ region: REGION, quotaCode: "instance_vcpu", limit: 8 }],
  });
  const p3 = await seedPool(t.pool, {
    id: P3,
    tier: "new",
    status: "disabled",
    cells: [{ region: REGION, quotaCode: "instance_vcpu", limit: 8 }],
  });
  return [p1, p2, p3] as const;
};

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("lockCells", () => {
  it("returns the asked cells of one account, ordered by row id, as web_rw, worker_rw and admin_rw", async () => {
    const [p1] = await seedThree();
    for (const role of ["web_rw", "worker_rw", "admin_rw"] as const) {
      expect(
        await as(role, (tx) => capacityRepo(tx).lockCells({ accountId: P1, cells: CELLS })),
      ).toEqual([
        {
          rowId: p1.rows[`${REGION}/instance_vcpu`],
          poolAccountId: P1,
          region: REGION,
          quotaCode: "instance_vcpu",
          limit: 4,
          used: 1,
          status: "active",
        },
        {
          rowId: p1.rows[`${REGION}/static_ip`],
          poolAccountId: P1,
          region: REGION,
          quotaCode: "static_ip",
          limit: 5,
          used: 0,
          status: "active",
        },
      ]);
    }
  });
  it("returns the active accounts of the asked tiers and no others, ordered by row id", async () => {
    await seedThree();
    const lock = (tiers: string[], cells: readonly CellKey[]) =>
      as("web_rw", (tx) => capacityRepo(tx).lockCells({ tiers, cells }));
    const rows = await lock(["new"], CELLS);
    expect(rows.map((r) => [r.poolAccountId, r.quotaCode]).sort()).toEqual([
      [P1, "instance_vcpu"],
      [P1, "static_ip"],
    ]);
    const both = await lock(["new", "trusted"], [CELLS[0]!]);
    expect(both.map((r) => r.poolAccountId).sort()).toEqual([P1, P2]);
    for (const list of [rows, both]) {
      const ids = list.map((r) => r.rowId);
      expect(ids).toEqual([...ids].sort());
    }
  });
  it("refuses a selector that is not valid, before any query, in lockCells and readCells", async () => {
    const bad = [
      { accountId: "x", cells: CELLS },
      { accountId: P1, cells: [] },
      { tiers: [], cells: CELLS },
      { accountId: P1, cells: Array.from({ length: 21 }, () => CELLS[0]) },
    ];
    for (const method of ["lockCells", "readCells"] as const) {
      for (const selector of bad) {
        await expect(
          as("web_rw", (tx) => capacityRepo(tx)[method](selector as never)),
        ).rejects.toBeInstanceOf(TypeError);
      }
    }
  });
  it("locks the cells in id order, so a waiting order holds no later cell", async () => {
    const [LOW, HIGH] = [
      "00000000-0000-7000-8000-0000000000b1",
      "00000000-0000-7000-8000-0000000000b2",
    ];
    await seedPool(t.pool, { id: P1 });
    // the row with the higher id is inserted first, so a scan without ORDER BY meets it first
    await insertRow(t.pool, "pool_capacity", {
      id: HIGH,
      pool_account_id: P1,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 5,
    });
    await insertRow(t.pool, "pool_capacity", {
      id: LOW,
      pool_account_id: P1,
      region: REGION,
      quota_code: "instance_vcpu",
      quota_limit: 4,
    });
    const holder = await t.pool.connect();
    const probe = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from pool_capacity where id = $1 for update", [LOW]);
      const waiting = as("web_rw", (tx) =>
        capacityRepo(tx).lockCells({ accountId: P1, cells: CELLS }),
      );
      // wait until the order really waits for LOW (no fixed sleep): poll for an ungranted lock, at most 5 s
      let waiter = false;
      for (let i = 0; i < 250 && !waiter; i += 1) {
        const n = await probe.query(
          "select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.datname = current_database()",
        );
        waiter = (n.rows[0].n as number) > 0;
        if (!waiter) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiter).toBe(true);
      await probe.query("begin");
      const free = await probe.query(
        "select id from pool_capacity where id = $1 for update skip locked",
        [HIGH],
      );
      await probe.query("rollback");
      expect(free.rows).toHaveLength(1); // the waiting order has not locked the higher cell
      await holder.query("commit");
      expect((await waiting).map((r) => r.rowId)).toEqual([LOW, HIGH]);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      probe.release();
    }
  });
});

describe("readCells", () => {
  it("returns the rows of lockCells, in the same order", async () => {
    await seedThree();
    const selector = { tiers: ["new", "trusted"], cells: CELLS };
    const [locked, read] = await as(
      "web_rw",
      async (tx) =>
        [
          await capacityRepo(tx).lockCells(selector),
          await capacityRepo(tx).readCells(selector),
        ] as const,
    );
    expect(read).toEqual(locked);
    expect(read.length).toBeGreaterThan(0);
  });
  it("neither waits for a lock that another transaction holds nor takes one", async () => {
    await seedThree();
    const holder = await t.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from pool_capacity where pool_account_id = $1 for update", [
        P1,
      ]);
      const answer = await Promise.race([
        as("web_rw", (tx) => capacityRepo(tx).readCells({ accountId: P1, cells: CELLS })),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2000)),
      ]);
      expect(answer).not.toBe("blocked");
      expect(answer).toHaveLength(2);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });
});

describe("setUsed", () => {
  it("changes used as web_rw and as worker_rw", async () => {
    const [p1] = await seedThree();
    const row = p1.rows[`${REGION}/static_ip`]!;
    await as("web_rw", (tx) =>
      capacityRepo(tx).setUsed([{ rowId: row, used: 1, expectedUsed: 0 }]),
    );
    await as("worker_rw", (tx) =>
      capacityRepo(tx).setUsed([{ rowId: row, used: 3, expectedUsed: 1 }]),
    );
    expect((await readUsed(t.pool, P1))[`${REGION}/static_ip`]).toBe(3);
  });
  it("changes nothing and throws when a row is not as it was read", async () => {
    const [p1] = await seedThree();
    const [a, b] = [p1.rows[`${REGION}/instance_vcpu`]!, p1.rows[`${REGION}/static_ip`]!];
    await expect(
      as("web_rw", (tx) =>
        capacityRepo(tx).setUsed([
          { rowId: b, used: 1, expectedUsed: 0 },
          { rowId: a, used: 3, expectedUsed: 0 },
        ]),
      ),
    ).rejects.toThrow("capacity: a locked row changed");
    expect(await readUsed(t.pool, P1)).toEqual({
      [`${REGION}/instance_vcpu`]: 1,
      [`${REGION}/static_ip`]: 0,
      "us-east-1/static_ip": 0,
    });
  });
  it("is refused for admin_rw, which may change the limit and not used", async () => {
    const [p1] = await seedThree();
    await expect(
      as("admin_rw", (tx) =>
        capacityRepo(tx).setUsed([
          { rowId: p1.rows[`${REGION}/static_ip`]!, used: 1, expectedUsed: 0 },
        ]),
      ),
    ).rejects.toMatchObject({ name: "DbError", code: "42501" });
  });
});

describe("readReserves", () => {
  const put = (
    key: string,
    value: unknown,
    market = "BD",
    scope = "market",
    scope_id: string | null = null,
  ) =>
    insertRow(t.pool, "settings", { key, market, scope, scope_id, value: JSON.stringify(value) });
  const read = (market = "BD") => as("web_rw", (tx) => capacityRepo(tx).readReserves(market));
  it("reads the reserves of the market, and nothing else", async () => {
    await ensureMarket(t.pool, "XX");
    await put("capacity.reserve.instance_vcpu", 2);
    await put("capacity.reserve.static_ip", 0);
    await put("capacity.reserve.bucket", 9, "XX");
    await put("unrelated.key", 7);
    await put("capacity.reserve.disk_gb", 5, "BD", "tier", "new");
    expect(await read()).toEqual(
      new Map([
        ["instance_vcpu", 2],
        ["static_ip", 0],
      ]),
    );
    expect(await read("XX")).toEqual(new Map([["bucket", 9]]));
  });
  it("fails closed on a value that is not a whole number of units and on a key that names no quota", async () => {
    for (const bad of [1.5, -1, "2", null, { n: 1 }]) {
      await resetCapacity(t.pool);
      await put("capacity.reserve.instance_vcpu", bad);
      await expect(read()).rejects.toThrow(
        "capacity: a reserve setting is not a whole number of units",
      );
    }
    await resetCapacity(t.pool);
    await put("capacity.reserve.gpu", 1);
    await expect(read()).rejects.toThrow("capacity: a reserve setting names no quota code");
  });
});

describe("two connections at the same moment", () => {
  it("one of two transactions that want the last unit gets it; the other waits and sees the unit gone", async () => {
    const p = await seedPool(t.pool, {
      cells: [{ region: REGION, quotaCode: "static_ip", limit: 5, used: 4 }],
    });
    const row = p.rows[`${REGION}/static_ip`]!;
    let winnerSawWaiter = false;
    const grab = () =>
      as("web_rw", async (tx) => {
        const repo = capacityRepo(tx);
        const [cell] = await repo.lockCells({
          accountId: p.poolAccountId,
          cells: [{ region: REGION, quotaCode: "static_ip" }],
        });
        if (!cell || cell.used + 1 > cell.limit) return "full";
        await repo.setUsed([{ rowId: row, used: cell.used + 1, expectedUsed: cell.used }]);
        winnerSawWaiter = await holdUntilWaiter(tx, 5); // keep the lock until the other order is really waiting
        return "got it";
      });
    const results = await Promise.all([grab(), grab()]);
    expect(results.sort()).toEqual(["full", "got it"]);
    expect(winnerSawWaiter).toBe(true); // the second order waited for the first
    expect((await readUsed(t.pool, p.poolAccountId))[`${REGION}/static_ip`]).toBe(5);
  });
});
