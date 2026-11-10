import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, insertRow } from "./sql";
import { newAdmin, newCustomer, newPoolAccount, newResource, uniqueSuffix } from "./fixtures";
import { columnTests } from "./expected-columns";

const t = useTempDatabase();
columnTests(
  () => t.pool,
  [
    "pool_accounts",
    "pool_capacity",
    "customer_homes",
    "resources",
    "subscriptions",
    "operations",
    "usage_records",
  ],
);

it("a pool account id has 12 digits and is unique", async () => {
  const row = {
    aws_account_id: "123456789012",
    name: "tc-pool-dev",
    tier: "dev",
    role_arn: "arn:aws:iam::123456789012:role/TcProvisioner",
    external_id: "x",
    status: "active",
  };
  await insertRow(t.pool, "pool_accounts", row);
  await expectSqlError(insertRow(t.pool, "pool_accounts", { ...row, name: "other" }), "23505", {
    constraint: "pool_accounts_aws_account_id_unique",
  });
  await expectSqlError(
    insertRow(t.pool, "pool_accounts", { ...row, aws_account_id: "12345678901", name: "n2" }),
    "23514",
    { constraint: "pool_accounts_aws_account_id_check" },
  );
});

it.each([
  "instance_vcpu",
  "static_ip",
  "database",
  "load_balancer",
  "container_service",
  "certificate_active",
  "certificate_365d",
  "disk_gb",
  "bucket",
  "distribution",
])("pool_capacity takes the quota code %s once", async (quota_code) => {
  const pool_account_id = await newPoolAccount(t.pool);
  const row = { pool_account_id, region: "ap-southeast-1", quota_code, quota_limit: 20 };
  const id = await insertRow(t.pool, "pool_capacity", row);
  expect(
    (await t.pool.query("select used from pool_capacity where id = $1", [id])).rows[0].used,
  ).toBe(0);
  await expectSqlError(insertRow(t.pool, "pool_capacity", row), "23505", {
    constraint: "pool_capacity_pool_account_id_region_quota_code_unique",
  });
});

it("pool_capacity refuses an unknown quota code and a negative use", async () => {
  const pool_account_id = await newPoolAccount(t.pool);
  await expectSqlError(
    insertRow(t.pool, "pool_capacity", {
      pool_account_id,
      region: "ap-south-1",
      quota_code: "vcpu",
      quota_limit: 1,
    }),
    "23514",
    { constraint: "pool_capacity_quota_code_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "pool_capacity", {
      pool_account_id,
      region: "ap-south-1",
      quota_code: "bucket",
      quota_limit: 1,
      used: -1,
    }),
    "23514",
    { constraint: "pool_capacity_used_check" },
  );
});

it("a customer has one home per Region", async () => {
  const customer_id = await newCustomer(t.pool);
  const pool_account_id = await newPoolAccount(t.pool);
  await insertRow(t.pool, "customer_homes", {
    customer_id,
    region: "ap-southeast-1",
    pool_account_id,
  });
  await insertRow(t.pool, "customer_homes", { customer_id, region: "ap-south-1", pool_account_id });
  await expectSqlError(
    insertRow(t.pool, "customer_homes", { customer_id, region: "ap-southeast-1", pool_account_id }),
    "23505",
    { constraint: "customer_homes_customer_id_region_unique" },
  );
});

it("resources: the six states, destroyed exactly when deleted_at is set, unique AWS names", async () => {
  const c = await newCustomer(t.pool);
  const id = await newResource(t.pool, c, { aws_name: "tc-instance-0123456789abcdef" });
  expect(
    (await t.pool.query("select state, config from resources where id = $1", [id])).rows[0],
  ).toEqual({ state: "creating", config: {} });
  await expectSqlError(newResource(t.pool, c, { state: "deleted" }), "23514", {
    constraint: "resources_state_check",
  });
  await expectSqlError(newResource(t.pool, c, { state: "destroyed" }), "23514", {
    constraint: "resources_deleted_check",
  });
  await expectSqlError(newResource(t.pool, c, { deleted_at: "2026-11-11T00:00:00Z" }), "23514", {
    constraint: "resources_deleted_check",
  });
  await newResource(t.pool, c, { state: "destroyed", deleted_at: "2026-11-11T00:00:00Z" });
  await expectSqlError(
    newResource(t.pool, c, { aws_name: "tc-instance-0123456789abcdef" }),
    "23505",
    { constraint: "resources_aws_name_unique" },
  );
  await expectSqlError(
    newResource(t.pool, c, {
      family: "backup",
      parent_resource_id: "01900000-0000-7000-8000-000000000000",
    }),
    "23503",
  );
  await newResource(t.pool, c, { family: "backup", parent_resource_id: id });
});

it("subscriptions: one per resource, a real period, the four states of section 11", async () => {
  const c = await newCustomer(t.pool);
  const resource_id = await newResource(t.pool, c);
  const sub = {
    resource_id,
    customer_id: c,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-11-11T00:00:00Z",
    period_end: "2026-12-11T00:00:00Z",
  };
  const id = await insertRow(t.pool, "subscriptions", sub);
  expect(
    (await t.pool.query("select status, auto_renew from subscriptions where id = $1", [id]))
      .rows[0],
  ).toEqual({ status: "active", auto_renew: false });
  await expectSqlError(insertRow(t.pool, "subscriptions", sub), "23505", {
    constraint: "subscriptions_resource_id_unique",
  });
  const other = await newResource(t.pool, c);
  await expectSqlError(
    insertRow(t.pool, "subscriptions", {
      ...sub,
      resource_id: other,
      period_end: sub.period_start,
    }),
    "23514",
    { constraint: "subscriptions_period_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "subscriptions", { ...sub, resource_id: other, status: "expired" }),
    "23514",
    { constraint: "subscriptions_status_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "subscriptions", { ...sub, resource_id: other, term_days: 0 }),
    "23514",
    { constraint: "subscriptions_term_days_check" },
  );
});

it("operations: the seven states of 10.1, defaults, one row per idempotency key", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  for (const state of [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "needs_approval",
    "needs_attention",
  ]) {
    await insertRow(t.pool, "operations", {
      resource_id,
      kind: "create",
      state,
      idempotency_key: "op-" + state,
      needs_approval: state === "needs_approval",
    });
  }
  const { rows } = await t.pool.query(
    "select attempts, enqueue_seq, needs_approval, approved_by, payload, next_run_at is not null as has_next from operations where idempotency_key = 'op-queued'",
  );
  expect(rows[0]).toEqual({
    attempts: 0,
    enqueue_seq: 0,
    needs_approval: false,
    approved_by: null,
    payload: {},
    has_next: true,
  });
  await expectSqlError(
    insertRow(t.pool, "operations", { resource_id, kind: "create", idempotency_key: "op-queued" }),
    "23505",
    { constraint: "operations_idempotency_key_unique" },
  );
  await expectSqlError(
    insertRow(t.pool, "operations", {
      resource_id,
      kind: "create",
      state: "pending",
      idempotency_key: "op-x",
    }),
    "23514",
    { constraint: "operations_state_check" },
  );
});

it("operations: ruling 5 ties the state and approved_by to the needs_approval column", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const admin = await newAdmin(t.pool, "ops");
  await expectSqlError(
    insertRow(t.pool, "operations", {
      resource_id,
      kind: "destroy",
      state: "needs_approval",
      idempotency_key: "op-na",
    }),
    "23514",
    { constraint: "operations_needs_approval_state_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "operations", {
      resource_id,
      kind: "destroy",
      approved_by: admin,
      idempotency_key: "op-ab",
    }),
    "23514",
    { constraint: "operations_approved_by_check" },
  );
  await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    needs_approval: true,
    approved_by: admin,
    idempotency_key: "op-ok",
  });
});

it("operations: ruling 6, an operation that needs approval only waits or fails until it has an approver", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const admin = await newAdmin(t.pool, "ops");
  const op = (over: Record<string, unknown>) =>
    insertRow(t.pool, "operations", {
      resource_id,
      kind: "destroy",
      needs_approval: true,
      idempotency_key: "op-" + uniqueSuffix(),
      ...over,
    });
  await expectSqlError(op({}), "23514", { constraint: "operations_unapproved_state_check" });
  await expectSqlError(op({ state: "running" }), "23514", {
    constraint: "operations_unapproved_state_check",
  });
  const waiting = await op({ state: "needs_approval" });
  await op({ state: "failed" });
  await op({ state: "succeeded", approved_by: admin });
  await expectSqlError(
    t.pool.query("update operations set state = 'queued' where id = $1", [waiting]),
    "23514",
    { constraint: "operations_unapproved_state_check" },
  );
  const moved = await t.pool.query(
    "update operations set approved_by = $1, state = 'queued' where id = $2",
    [admin, waiting],
  );
  expect(moved.rowCount).toBe(1);
});

it("usage_records: one row per resource, metric and period", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const row = { resource_id, metric: "transfer_gb", period: "2026-11-11T13", quantity: "1.5" };
  await insertRow(t.pool, "usage_records", row);
  await expectSqlError(insertRow(t.pool, "usage_records", row), "23505", {
    constraint: "usage_records_resource_id_metric_period_unique",
  });
  await expectSqlError(
    insertRow(t.pool, "usage_records", { ...row, period: "2026-11-11T14", quantity: "-1" }),
    "23514",
    { constraint: "usage_records_quantity_check" },
  );
});
