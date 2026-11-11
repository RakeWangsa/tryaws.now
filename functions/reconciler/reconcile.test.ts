// WP7-T6 against a real database: the reconciler run as worker_rw with a fake, read-only inventory
// port. No AWS call. Needs the local PostgreSQL (pnpm db:up).
import { randomInt } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AwsItem, LogEvent } from "@tc/core";
import { createManualClock } from "@tc/core";
import type { Tx } from "@tc/db";
import {
  ensureMarket,
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { fakeInventory } from "./fake-inventory";
import { ReconcileIncompleteError, runReconcile, type ReconcileDeps } from "./reconcile";

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

const NOW = new Date("2026-11-12T02:00:00Z");
const REGION = "ap-southeast-1";
let customerId: string;

beforeAll(async () => {
  await ensureMarket(t.pool);
  customerId = await newCustomer(t.pool);
});

// Every test sees only its own pool accounts: the earlier ones are switched off.
beforeEach(async () => {
  await q("update pool_accounts set status = 'disabled'");
});

async function newPool(): Promise<{ id: string; awsAccountId: string }> {
  const awsAccountId = Array.from({ length: 12 }, () => randomInt(10)).join("");
  const id = await insertRow(t.pool, "pool_accounts", {
    aws_account_id: awsAccountId,
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: `arn:aws:iam::${awsAccountId}:role/TcReader`,
    external_id: uniqueSuffix(),
    status: "active",
  });
  return { id, awsAccountId };
}
const name = () =>
  "tc-instance-" +
  uniqueSuffix()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 16)
    .padEnd(16, "0");
async function newRow(poolId: string, over: Record<string, unknown> = {}) {
  const awsName = name();
  const id = await newResource(t.pool, customerId, {
    pool_account_id: poolId,
    region: REGION,
    aws_name: awsName,
    state: "active",
    ...over,
  });
  await q("update resources set created_at = '2026-11-01T00:00:00Z' where id = $1", [id]);
  return { id, awsName };
}
const item = (awsName: string, over: Partial<AwsItem> = {}): AwsItem => ({
  region: REGION,
  family: "linux_instance",
  awsName,
  state: "active",
  tagged: true,
  ...over,
});

function setup(
  script: Parameters<typeof fakeInventory>[0],
  extra: Partial<ReconcileDeps> = {},
): { deps: ReconcileDeps; logs: LogEvent[] } {
  const logs: LogEvent[] = [];
  const deps: ReconcileDeps = {
    runTx: worker,
    port: fakeInventory(script),
    clock: createManualClock(NOW),
    log: (e) => logs.push(e),
    ...extra,
  };
  return { deps, logs };
}
const findingsOf = async (poolId: string) =>
  q("select kind, details from discrepancies where details ->> 'poolAccountId' = $1 order by id", [
    poolId,
  ]);

describe("inventory comparison", () => {
  it("writes an orphan, a missing resource and a drift, and a second run of the day adds nothing (R7)", async () => {
    const pool = await newPool();
    const same = await newRow(pool.id);
    const gone = await newRow(pool.id);
    const drift = await newRow(pool.id);
    const orphanName = name();
    const { deps, logs } = setup({
      [pool.id]: {
        items: [
          item(same.awsName),
          item(drift.awsName, { state: "stopped" }),
          item(orphanName),
          item(name(), { tagged: false }),
        ],
        live: [],
      },
    });
    const first = await runReconcile(deps);
    expect(first).toMatchObject({
      accounts: 1,
      orphans: 1,
      missing: 2,
      newFindings: 3,
      replayedFindings: 0,
      unreachable: [],
    });
    const rows = await findingsOf(pool.id);
    expect(
      rows.map((r) => `${r.kind}:${(r.details as Record<string, string>).reason}`).sort(),
    ).toEqual(["missing:no_aws_resource", "missing:state_drift", "orphan:no_row"]);
    const orphan = rows.find((r) => r.kind === "orphan")?.details as Record<string, string>;
    expect(orphan).toMatchObject({ awsName: orphanName, dayKey: "2026-11-12" });
    const missing = rows.find(
      (r) => (r.details as Record<string, string>).reason === "no_aws_resource",
    );
    expect((missing?.details as Record<string, string>).resourceId).toBe(gone.id);

    const second = await runReconcile(deps);
    expect(second).toMatchObject({ newFindings: 0, replayedFindings: 3 });
    expect(await findingsOf(pool.id)).toHaveLength(3);

    // a structured alarm without ids of customers, account ids or secrets (R14)
    const alarm = logs.find((l) => l.event === "reconcile_findings");
    expect(alarm).toMatchObject({ severity: "alert", orphans: 1, missing: 2 });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(pool.awsAccountId);
    expect(text).not.toContain(customerId);
  });

  it("does not touch resources, operations or the ledger: it only reports (R5, R13)", async () => {
    const pool = await newPool();
    const gone = await newRow(pool.id);
    const orphan = await newRow(pool.id, { state: "destroyed", deleted_at: NOW });
    const before = await q("select id, state, config, deleted_at from resources order by id");
    const ledgerBefore = await q("select count(*)::int as n from ledger_entries");
    const { deps } = setup({ [pool.id]: { items: [item(orphan.awsName)], live: [] } });
    await runReconcile(deps);
    expect(await q("select id, state, config, deleted_at from resources order by id")).toEqual(
      before,
    );
    expect(await q("select count(*)::int as n from ledger_entries")).toEqual(ledgerBefore);
    const kinds = (await findingsOf(pool.id)).map(
      (r) => (r.details as Record<string, string>).reason,
    );
    expect(kinds.sort()).toEqual(["no_aws_resource", "row_destroyed"]);
    expect(gone.id).toBeDefined();
  });

  it("an unreachable account is reported and never read as 'nothing exists' (R16)", async () => {
    const down = await newPool();
    const up = await newPool();
    const row = await newRow(down.id); // would be "missing" if the empty answer were believed
    const upRow = await newRow(up.id);
    await insertRow(t.pool, "pool_capacity", {
      pool_account_id: down.id,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 5,
      used: 4,
    });
    const { deps, logs } = setup({
      [down.id]: { fail: "unreachable" },
      [up.id]: { items: [], live: [] }, // reachable and really empty
    });
    const result = await runReconcile(deps);
    expect(result.unreachable).toEqual([{ poolAccountId: down.id, reason: "unreachable" }]);
    expect(result.incomplete).toBe(true);
    expect(await findingsOf(down.id)).toEqual([]);
    expect(
      (await q("select used from pool_capacity where pool_account_id = $1", [down.id]))[0]?.used,
    ).toBe(4);
    // the reachable account was still compared
    expect(
      (await findingsOf(up.id)).map((r) => (r.details as Record<string, string>).resourceId),
    ).toEqual([upRow.id]);
    expect(logs.find((l) => l.event === "reconcile_incomplete")).toMatchObject({
      severity: "alert",
      unreachable: 1,
    });
    expect(row.id).toBeDefined();
  });

  it("a port that throws, or an account the port does not know, counts as unreachable", async () => {
    const pool = await newPool();
    const { deps } = setup({ [pool.id]: { throws: true } });
    const result = await runReconcile(deps);
    expect(result.unreachable).toContainEqual({ poolAccountId: pool.id, reason: "unreachable" });
    const unknown = await newPool();
    const r2 = await runReconcile(setup({}).deps);
    expect(r2.unreachable.map((u) => u.poolAccountId)).toContain(unknown.id);
  });

  it("ReconcileIncompleteError is what the handler throws for an incomplete run", () => {
    const e = new ReconcileIncompleteError(2, 1);
    expect(e.name).toBe("ReconcileIncompleteError");
    expect(e.message).toBe(
      "reconcile: 2 accounts unreachable, 1 capacity cells without a live count",
    );
  });
});

describe("capacity", () => {
  it("corrects used from the live count through recomputeUsed, with one audit row, once", async () => {
    const pool = await newPool();
    await insertRow(t.pool, "pool_capacity", {
      pool_account_id: pool.id,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 5,
      used: 4,
    });
    const { deps } = setup({
      [pool.id]: { items: [], live: [{ region: REGION, quotaCode: "static_ip", live: 2 }] },
    });
    const first = await runReconcile(deps);
    expect(first.capacityCorrected).toBe(1);
    const row = () =>
      q("select used, checked_at from pool_capacity where pool_account_id = $1", [pool.id]);
    expect((await row())[0]?.used).toBe(2);
    expect((await row())[0]?.checked_at).not.toBeNull();
    const audit = () =>
      q("select metadata from audit_log where action = 'capacity.corrected' and target_id = $1", [
        pool.id,
      ]);
    expect(await audit()).toEqual([
      { metadata: { region: REGION, quotaCode: "static_ip", previous: 4, used: 2 } },
    ]);
    const second = await runReconcile(deps);
    expect(second.capacityCorrected).toBe(0);
    expect(await audit()).toHaveLength(1);
  });

  it("never sets used below the live count plus the reservations of creates that have not succeeded", async () => {
    const pool = await newPool();
    await insertRow(t.pool, "pool_capacity", {
      pool_account_id: pool.id,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 5,
      used: 0,
    });
    await newRow(pool.id, {
      state: "creating",
      config: {
        capacityReservation: { cells: [{ region: REGION, quotaCode: "static_ip", amount: 1 }] },
      },
    });
    const { deps } = setup({
      [pool.id]: { items: [], live: [{ region: REGION, quotaCode: "static_ip", live: 2 }] },
    });
    await runReconcile(deps);
    expect(
      (await q("select used from pool_capacity where pool_account_id = $1", [pool.id]))[0]?.used,
    ).toBe(3);
  });

  it("a cell with no live count is left alone and the run is incomplete", async () => {
    const pool = await newPool();
    await insertRow(t.pool, "pool_capacity", {
      pool_account_id: pool.id,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 5,
      used: 4,
    });
    const { deps } = setup({ [pool.id]: { items: [], live: [] } });
    const result = await runReconcile(deps);
    expect(result.capacitySkipped).toBe(1);
    expect(result.incomplete).toBe(true);
    expect(
      (await q("select used from pool_capacity where pool_account_id = $1", [pool.id]))[0]?.used,
    ).toBe(4);
  });

  it("raises an alarm when the live count is above the quota limit", async () => {
    const pool = await newPool();
    await insertRow(t.pool, "pool_capacity", {
      pool_account_id: pool.id,
      region: REGION,
      quota_code: "static_ip",
      quota_limit: 1,
      used: 1,
    });
    const { deps, logs } = setup({
      [pool.id]: { items: [], live: [{ region: REGION, quotaCode: "static_ip", live: 3 }] },
    });
    const result = await runReconcile(deps);
    expect(result.capacityOverLimit).toBeGreaterThanOrEqual(1);
    expect(logs.find((l) => l.event === "reconcile_capacity_over_limit")).toMatchObject({
      severity: "alert",
    });
  });
});

describe("stale operations and the role", () => {
  it("reports an operation no worker has moved for hours and changes nothing", async () => {
    const pool = await newPool();
    const res = await newRow(pool.id);
    const opId = await insertRow(t.pool, "operations", {
      resource_id: res.id,
      kind: "create",
      state: "running",
      idempotency_key: "stale-" + uniqueSuffix(),
    });
    await q("update operations set next_run_at = $2 where id = $1", [opId, "2026-11-11T20:00:00Z"]);
    const { deps, logs } = setup({ [pool.id]: { items: [item(res.awsName)], live: [] } });
    const result = await runReconcile(deps);
    expect(result.staleOperations).toBeGreaterThanOrEqual(1);
    const line = logs.find((l) => l.event === "reconcile_stale_operations");
    expect(line).toMatchObject({ severity: "alert" });
    expect(String(line?.operationIds)).toContain(opId);
    expect((await q("select state, attempts from operations where id = $1", [opId]))[0]).toEqual({
      state: "running",
      attempts: 0,
    });
  });

  it("refuses to run under a role other than worker_rw", async () => {
    const { deps } = setup(
      {},
      {
        runTx: (fn) => runTransaction(t.db, fn, { role: "web_rw" }),
        requireRole: "worker_rw",
      },
    );
    await expect(runReconcile(deps)).rejects.toThrow("the connection does not have the role");
  });
});
