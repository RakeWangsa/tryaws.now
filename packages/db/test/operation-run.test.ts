import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import {
  loadOperationBrief,
  loadOwnedResource,
  loadRunView,
  patchResource,
  selectDue,
  updateOperation,
} from "../operations/run";
import { runTransaction } from "../tx";
import { inTransaction, insertRow } from "./sql";
import { newAdmin, newCustomer, newOrder, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
let resourceId = "";
let poolId = "";
let adminId = "";
beforeAll(async () => {
  const awsAccountId = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join("");
  poolId = await insertRow(t.pool, "pool_accounts", {
    aws_account_id: awsAccountId,
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: `arn:aws:iam::${awsAccountId}:role/TcProvisioner`,
    external_id: "ext-" + uniqueSuffix(),
    status: "active",
  });
  resourceId = await newResource(t.pool, await newCustomer(t.pool), {
    pool_account_id: poolId,
    region: "ap-southeast-1",
  });
  adminId = await newAdmin(t.pool, "ops");
});
const seed = (state: string, over: Record<string, unknown> = {}, resource = resourceId) =>
  insertRow(t.pool, "operations", {
    resource_id: resource,
    kind: "reboot",
    state,
    idempotency_key: "r:" + uniqueSuffix(),
    ...over,
  });
const row = async (id: string) =>
  (await t.pool.query("select * from operations where id = $1", [id])).rows[0];

describe("loadRunView", () => {
  it("returns the operation, its resource and only the four pool columns the worker may read", async () => {
    const id = await seed("queued", { payload: { a: 1 } });
    const view = await worker((tx) => loadRunView(tx, id));
    expect(view?.operation).toMatchObject({
      id,
      resourceId,
      kind: "reboot",
      state: "queued",
      attempts: 0,
      enqueueSeq: 0,
      payload: { a: 1 },
    });
    expect(view?.operation.nextRunAt).toBeInstanceOf(Date);
    expect(view?.resource).toMatchObject({
      id: resourceId,
      family: "linux_instance",
      region: "ap-southeast-1",
      poolAccountId: poolId,
    });
    expect(Object.keys(view!.pool!).sort()).toEqual(["awsAccountId", "externalId", "id", "status"]);
    expect(view?.blockedBy).toBeNull();
  });

  it("returns null for an unknown id and for text that is not a UUID", async () => {
    expect(
      await worker((tx) => loadRunView(tx, "01a1c97d-e814-7352-b32c-d3d3ee408ab8")),
    ).toBeNull();
    expect(await worker((tx) => loadRunView(tx, "not-a-uuid"))).toBeNull();
  });

  it("locks the operation row until the transaction ends", async () => {
    const id = await seed("queued");
    await worker(async (tx) => {
      await loadRunView(tx, id);
      await expect(
        t.pool.query("select 1 from operations where id = $1 for update nowait", [id]),
      ).rejects.toMatchObject({ code: "55P03" });
    });
  });

  it("blockedBy is the oldest older operation that is queued, running or waiting, and nothing else blocks", async () => {
    const resource = await newResource(t.pool, await newCustomer(t.pool), {
      pool_account_id: poolId,
      region: "ap-southeast-1",
    });
    await seed("succeeded", {}, resource);
    await seed("failed", {}, resource);
    await seed("needs_attention", {}, resource);
    await seed("needs_approval", { needs_approval: true, kind: "destroy" }, resource);
    const waiting = await seed("waiting", {}, resource);
    const queued = await seed("queued", {}, resource);
    const target = await seed("queued", {}, resource);
    const viewOf = (id: string) => worker((tx) => loadRunView(tx, id));
    expect((await viewOf(target))?.blockedBy).toBe(waiting);
    expect((await viewOf(queued))?.blockedBy).toBe(waiting);
    expect((await viewOf(waiting))?.blockedBy).toBeNull();
  });

  it("[Review Focus 8] a younger running operation blocks an older one that an admin retried, and a running one is named first", async () => {
    const resource = await newResource(t.pool, await newCustomer(t.pool), {
      pool_account_id: poolId,
      region: "ap-southeast-1",
    });
    const retried = await seed("queued", {}, resource);
    const waiting = await seed("waiting", {}, resource);
    const running = await seed("running", {}, resource);
    const viewOf = (id: string) => worker((tx) => loadRunView(tx, id));
    expect((await viewOf(retried))?.blockedBy).toBe(running);
    expect((await viewOf(waiting))?.blockedBy).toBe(running);
    expect((await viewOf(running))?.blockedBy).toBe(retried);
  });

  it("owner holds the customer of the key and, for a create, the customer of the order", async () => {
    const customer = await newCustomer(t.pool);
    const resource = await newResource(t.pool, customer, {
      pool_account_id: poolId,
      region: "ap-southeast-1",
    });
    const customerKey = await seed(
      "queued",
      { idempotency_key: `customer:${customer}:k-${uniqueSuffix()}` },
      resource,
    );
    expect((await worker((tx) => loadRunView(tx, customerKey)))?.owner).toEqual({
      orderCustomerId: null,
      keyCustomerId: customer,
    });
    const noOrder = await seed(
      "queued",
      { kind: "create", payload: { orderId: "not-a-uuid" } },
      resource,
    );
    expect((await worker((tx) => loadRunView(tx, noOrder)))?.owner).toEqual({
      orderCustomerId: null,
      keyCustomerId: null,
    });
    const orderId = await newOrder(t.pool, customer);
    const withOrder = await seed("queued", { kind: "create", payload: { orderId } }, resource);
    expect((await worker((tx) => loadRunView(tx, withOrder)))?.owner).toEqual({
      orderCustomerId: customer,
      keyCustomerId: null,
    });
  });
});

describe("loadOperationBrief and loadOwnedResource", () => {
  it("the brief has seven columns, is null for an unknown id and a non-UUID, and locks the row", async () => {
    const id = await seed("needs_attention");
    expect(await worker((tx) => loadOperationBrief(tx, id))).toEqual({
      id,
      resourceId,
      kind: "reboot",
      state: "needs_attention",
      step: null,
      attempts: 0,
      lastError: null,
    });
    // WPU-Z13: the step tells the rejection whether the registry holds a domain renewal already.
    const held = await seed("needs_attention", { kind: "renew_domain", step: "poll" });
    expect(await worker((tx) => loadOperationBrief(tx, held))).toEqual({
      id: held,
      resourceId,
      kind: "renew_domain",
      state: "needs_attention",
      step: "poll",
      attempts: 0,
      lastError: null,
    });
    // WPU-Y5 (c): attempts and last_error tell whether a dns_zone create at create_zone may have sent the create.
    const tried = await seed("needs_attention", {
      kind: "create",
      step: "create_zone",
      attempts: 2,
      last_error: "upstream_unavailable:ServiceException",
    });
    expect(await worker((tx) => loadOperationBrief(tx, tried))).toMatchObject({
      step: "create_zone",
      attempts: 2,
      lastError: "upstream_unavailable:ServiceException",
    });
    expect(
      await worker((tx) => loadOperationBrief(tx, "01a1c97d-e814-7352-b32c-d3d3ee408ab8")),
    ).toBeNull();
    expect(await worker((tx) => loadOperationBrief(tx, "x"))).toBeNull();
  });

  it("an owned resource is found for its customer only, and a non-UUID id sends no query", async () => {
    const mine = await newCustomer(t.pool);
    const other = await newCustomer(t.pool);
    const id = await newResource(t.pool, mine);
    expect((await worker((tx) => loadOwnedResource(tx, mine, id)))?.id).toBe(id);
    expect(await worker((tx) => loadOwnedResource(tx, other, id))).toBeNull();
    expect(
      await worker((tx) => loadOwnedResource(tx, mine, "01a1c97d-e814-7352-b32c-d3d3ee408ab8")),
    ).toBeNull();
    expect(await worker((tx) => loadOwnedResource(tx, mine, "abc"))).toBeNull();
  });
});

describe("updateOperation", () => {
  it("moves a queued operation to running with a lease, once", async () => {
    const id = await seed("queued");
    const lease = new Date("2030-01-01T00:02:00.123Z");
    expect(
      await worker((tx) =>
        updateOperation(tx, { id, from: "queued", to: "running", nextRunAt: lease }),
      ),
    ).toEqual({ applied: true, enqueueSeq: 0 });
    expect(
      await worker((tx) =>
        updateOperation(tx, { id, from: "queued", to: "running", nextRunAt: lease }),
      ),
    ).toEqual({ applied: false });
    expect((await row(id)).state).toBe("running");
    expect((await row(id)).next_run_at.getTime()).toBe(lease.getTime());
  });

  it("[Review Focus 4] a record under a stale fence changes nothing", async () => {
    const lease = new Date("2030-01-01T00:02:00.123Z");
    const id = await seed("running", { next_run_at: lease });
    const stale = new Date(lease.getTime() + 1);
    expect(
      await worker((tx) =>
        updateOperation(tx, { id, from: "running", fence: stale, to: "succeeded" }),
      ),
    ).toEqual({ applied: false });
    expect((await row(id)).state).toBe("running");
    expect(
      await worker((tx) =>
        updateOperation(tx, { id, from: "running", fence: lease, to: "succeeded" }),
      ),
    ).toEqual({ applied: true, enqueueSeq: 0 });
  });

  it("sets step, attempts, last error and next_run_at, clears with null, and bumps enqueue_seq in one statement", async () => {
    const id = await seed("running", { step: "old", attempts: 3, last_error: "x", enqueue_seq: 4 });
    const at = new Date("2030-01-01T00:00:00.000Z");
    const result = await worker((tx) =>
      updateOperation(tx, {
        id,
        from: "running",
        to: "queued",
        step: "wait_running",
        attempts: 0,
        lastError: null,
        nextRunAt: at,
        bumpEnqueueSeq: true,
      }),
    );
    expect(result).toEqual({ applied: true, enqueueSeq: 5 });
    expect(await row(id)).toMatchObject({
      state: "queued",
      step: "wait_running",
      attempts: 0,
      last_error: null,
      enqueue_seq: 5,
    });
    const left = await worker((tx) => updateOperation(tx, { id, from: "queued", to: "waiting" }));
    expect(left).toEqual({ applied: true, enqueueSeq: 5 });
    expect(await row(id)).toMatchObject({ step: "wait_running", attempts: 0 });
  });

  it("cannot move a flagged operation without an approver (the CHECK), and can once it has one", async () => {
    const flagged = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    await expect(
      worker((tx) => updateOperation(tx, { id: flagged, from: "needs_approval", to: "queued" })),
    ).rejects.toMatchObject({ code: "23514" });
    const approved = await seed("queued", {
      needs_approval: true,
      kind: "destroy",
      approved_by: adminId,
    });
    expect(
      (await worker((tx) => updateOperation(tx, { id: approved, from: "queued", to: "running" })))
        .applied,
    ).toBe(true);
  });
});

describe("patchResource", () => {
  it("sets the state, merges the config and sets the aws name once", async () => {
    const id = await newResource(t.pool, await newCustomer(t.pool));
    const name = "tc-instance-0123456789abcdef";
    await worker((tx) =>
      patchResource(tx, id, { state: "active", awsName: name, configMerge: { ports: [22] } }),
    );
    await worker((tx) =>
      patchResource(tx, id, { awsName: name, configMerge: { ip: "198.51.100.7" } }),
    );
    const r = (
      await t.pool.query("select state, aws_name, config from resources where id = $1", [id])
    ).rows[0];
    expect(r).toEqual({
      state: "active",
      aws_name: name,
      config: { ports: [22], ip: "198.51.100.7" },
    });
    await expect(
      worker((tx) => patchResource(tx, id, { awsName: "tc-instance-fedcba9876543210" })),
    ).rejects.toThrow("resource: the aws name differs from the stored one");
  });

  it("destroyed needs deleted_at, and an empty patch sends nothing", async () => {
    const id = await newResource(t.pool, await newCustomer(t.pool));
    await expect(
      worker((tx) => patchResource(tx, id, { state: "destroyed" })),
    ).rejects.toMatchObject({ code: "23514" });
    await worker((tx) =>
      patchResource(tx, id, { state: "destroyed", deletedAt: new Date("2030-01-01T00:00:00Z") }),
    );
    await worker((tx) => patchResource(tx, id, {}));
    expect(
      (await t.pool.query("select state from resources where id = $1", [id])).rows[0].state,
    ).toBe("destroyed");
  });
});

describe("selectDue", () => {
  const T = new Date("2000-01-01T01:00:00.000Z");
  const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);

  it("returns waiting-due, queued-stale (120 seconds, to the second) and running-stale rows, oldest first", async () => {
    const resource = await newResource(t.pool, await newCustomer(t.pool));
    const ids = {
      qOld: await seed("queued", { next_run_at: at(-180) }, resource),
      qEdge: await seed("queued", { next_run_at: at(-120) }, resource),
      qNew: await seed("queued", { next_run_at: at(-60) }, resource),
      wDue: await seed("waiting", { next_run_at: at(-30) }, resource),
      wLater: await seed("waiting", { next_run_at: at(60) }, resource),
      rStale: await seed("running", { next_run_at: at(-90) }, resource),
      rLive: await seed("running", { next_run_at: at(60) }, resource),
      approval: await seed(
        "needs_approval",
        { needs_approval: true, kind: "destroy", next_run_at: at(-500) },
        resource,
      ),
      attention: await seed("needs_attention", { next_run_at: at(-500) }, resource),
      done: await seed("succeeded", { next_run_at: at(-500) }, resource),
    };
    const due = await worker((tx) => selectDue(tx, T, 120, 100));
    expect(due.map((d) => d.id)).toEqual([ids.qOld, ids.qEdge, ids.rStale, ids.wDue]);
    expect(due.map((d) => d.state)).toEqual(["queued", "queued", "running", "waiting"]);
    expect(due[0]).toEqual({
      id: ids.qOld,
      resourceId: resource,
      state: "queued",
      kind: "reboot",
      attempts: 0,
      enqueueSeq: 0,
    });
    expect((await worker((tx) => selectDue(tx, T, 120, 2))).map((d) => d.id)).toEqual([
      ids.qOld,
      ids.qEdge,
    ]);
  });

  it("skips a row that another transaction holds", async () => {
    const resource = await newResource(t.pool, await newCustomer(t.pool));
    const held = await seed("queued", { next_run_at: at(-300) }, resource);
    const free = await seed("queued", { next_run_at: at(-299) }, resource);
    await inTransaction(t.pool, async (c) => {
      await c.query("select 1 from operations where id = $1 for update", [held]);
      const due = await worker((tx) => selectDue(tx, T, 120, 100));
      expect(due.map((d) => d.id)).toContain(free);
      expect(due.map((d) => d.id)).not.toContain(held);
    });
  });
});
