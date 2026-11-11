import { beforeAll, expect, it } from "vitest";
import type { Tx } from "../client";
import { reconcileRepo } from "../repositories/system/reconcile";
import type { MethodsTakingCustomerId } from "../repositories/customer/index";
import { runTransaction } from "../tx";
import { ensureMarket, newCustomer, newPoolAccount, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];

// R8 at type level: no function of the module takes a customer id.
type AssertNever<T extends never> = T;
export type ReconcileTakesNoCustomerId = AssertNever<
  MethodsTakingCustomerId<{
    reconcile: {
      [K in keyof ReturnType<typeof reconcileRepo>]: (
        ...args: Parameters<ReturnType<typeof reconcileRepo>[K]>
      ) => unknown;
    };
  }>
>;

let customerId: string;
let poolId: string;

beforeAll(async () => {
  await ensureMarket(t.pool);
  customerId = await newCustomer(t.pool);
  poolId = await newPoolAccount(t.pool);
});

const aws = () =>
  `tc-instance-${uniqueSuffix()
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 16)
    .padEnd(16, "0")}`;

it("lists the active pool accounts with the ids the port needs, and no disabled one", async () => {
  const disabled = await newPoolAccount(t.pool);
  await q("update pool_accounts set status = 'disabled' where id = $1", [disabled]);
  const accounts = await worker((tx) => reconcileRepo(tx).activePoolAccounts());
  const ids = accounts.map((a) => a.id);
  expect(ids).toContain(poolId);
  expect(ids).not.toContain(disabled);
  const mine = accounts.find((a) => a.id === poolId);
  expect(Object.keys(mine ?? {}).sort()).toEqual(["awsAccountId", "externalId", "id"]);
});

it("reads the resources of one account with a name, in every state, and nothing of other accounts", async () => {
  const name = aws();
  const other = await newPoolAccount(t.pool);
  const kept = await newResource(t.pool, customerId, {
    pool_account_id: poolId,
    region: "ap-southeast-1",
    aws_name: name,
    state: "active",
  });
  await newResource(t.pool, customerId, {
    pool_account_id: other,
    aws_name: aws(),
    state: "active",
  });
  await newResource(t.pool, customerId, { pool_account_id: poolId }); // no aws name yet
  const rows = await worker((tx) => reconcileRepo(tx).resourcesOfAccount(poolId));
  const found = rows.find((r) => r.id === kept);
  expect(found).toMatchObject({
    family: "linux_instance",
    region: "ap-southeast-1",
    awsName: name,
    state: "active",
  });
  expect(found?.createdAt).toBeInstanceOf(Date);
  expect(rows.every((r) => r.awsName !== null)).toBe(true);
  expect(rows.map((r) => r.id)).not.toContain(undefined);
  // no customer id leaves the repository
  expect(Object.keys(found ?? {})).not.toContain("customerId");
});

it("reads the capacity rows of one account", async () => {
  await insertRow(t.pool, "pool_capacity", {
    pool_account_id: poolId,
    region: "ap-southeast-1",
    quota_code: "static_ip",
    quota_limit: 5,
    used: 2,
  });
  const rows = await worker((tx) => reconcileRepo(tx).capacityRows(poolId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    region: "ap-southeast-1",
    quotaCode: "static_ip",
    used: 2,
    quotaLimit: 5,
  });
});

it("lists the operations that are not finished, with a limit", async () => {
  const res = await newResource(t.pool, customerId, { pool_account_id: poolId });
  for (const state of ["queued", "running", "succeeded", "needs_attention"]) {
    await insertRow(t.pool, "operations", {
      resource_id: res,
      kind: "create",
      state,
      idempotency_key: `t-${state}-${uniqueSuffix()}`,
    });
  }
  const ops = await worker((tx) => reconcileRepo(tx).openOperations(100));
  const mine = ops.filter((o) => o.resourceId === res).map((o) => o.state);
  expect(mine.sort()).toEqual(["needs_attention", "queued", "running"]);
  await expect(worker((tx) => reconcileRepo(tx).openOperations(0))).rejects.toThrow(RangeError);
});

it("writes a finding once per id: the second write of the same id adds nothing (R7)", async () => {
  const id = "0190a000-0000-5000-8000-0000000000f1";
  const details = {
    reason: "no_row",
    poolAccountId: poolId,
    region: "ap-southeast-1",
    family: "linux_instance",
    awsName: aws(),
    dayKey: "2026-11-12",
  };
  const first = await worker((tx) => reconcileRepo(tx).recordFinding(id, "orphan", details));
  const second = await worker((tx) => reconcileRepo(tx).recordFinding(id, "orphan", details));
  expect([first, second]).toEqual([true, false]);
  const rows = await q("select kind, status, details from discrepancies where id = $1", [id]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "orphan", status: "open" });
});

it("refuses a finding with a key outside the list, a nested value, a bad kind or a bad id", async () => {
  const id = "0190a000-0000-5000-8000-0000000000f2";
  const repo = (tx: Tx) => reconcileRepo(tx);
  await expect(
    worker((tx) => repo(tx).recordFinding(id, "orphan", { email: "a@b.c" })),
  ).rejects.toThrow(TypeError);
  await expect(
    worker((tx) => repo(tx).recordFinding(id, "orphan", { reason: { nested: 1 } as never })),
  ).rejects.toThrow(TypeError);
  await expect(
    worker((tx) => repo(tx).recordFinding(id, "payment", { reason: "no_row" })),
  ).rejects.toThrow(TypeError);
  await expect(
    worker((tx) => repo(tx).recordFinding("not-a-uuid", "orphan", { reason: "no_row" })),
  ).rejects.toThrow(TypeError);
  expect(await q("select 1 from discrepancies where id = $1", [id])).toHaveLength(0);
});

it("records a capacity correction as one system audit row with the old and new value", async () => {
  await worker((tx) =>
    reconcileRepo(tx).recordCapacityCorrection({
      poolAccountId: poolId,
      region: "ap-southeast-1",
      quotaCode: "static_ip",
      previous: 2,
      used: 3,
    }),
  );
  const rows = await q(
    "select actor_type, actor_id, action, target_type, target_id, metadata from audit_log where action = 'capacity.corrected' and target_id = $1",
    [poolId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor_type: "system",
    actor_id: null,
    target_type: "pool_account",
    metadata: { region: "ap-southeast-1", quotaCode: "static_ip", previous: 2, used: 3 },
  });
});
