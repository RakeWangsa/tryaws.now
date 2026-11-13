import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import {
  attachedServerStatus,
  clearRetainedWithServer,
  lifecycleOperationKey,
  listDisksRetainedWithServer,
  recordDiskHeld,
  retainAttachedDisks,
  serverStatusForDisk,
} from "../repositories/system/attached-disks";
import { withCustomerRepos } from "../testing/repos";
import type { Tx } from "../client";
import { runTransaction } from "../tx";
import { insertFreshOperation } from "../operations/insert";
import { newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-Y4: a destroyed server takes its disks with it. The disks attached to a server (config.attachedInstanceId)
// are retained with it and get their own final snapshot and destroy, under the lifecycle engine's keys, for the
// server's customer only (R8), idempotently (R7).

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
// Fix round 3: the system calls run as worker_rw, the role of the lifecycle engine and the provisioner's guard,
// so the grants are part of the proof (the customer's destroy runs as web_rw through `as`).
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const PERIOD_END = "2026-01-31T00:00:00.000Z";

async function withSubscription(
  customerId: string,
  resourceId: string,
  status = "active",
): Promise<string> {
  return insertRow(t.pool, "subscriptions", {
    resource_id: resourceId,
    customer_id: customerId,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-01-01T00:00:00Z",
    period_end: PERIOD_END,
    status,
  });
}

async function server(customerId: string): Promise<string> {
  const id = await newResource(t.pool, customerId, { state: "active" });
  await withSubscription(customerId, id);
  return id;
}

async function disk(
  customerId: string,
  attachedTo: string | null,
  status = "active",
  state = "active",
): Promise<{ id: string; subscriptionId: string }> {
  const id = await newResource(t.pool, customerId, {
    family: "disk",
    state,
    // resources_deleted_check: a destroyed row has deleted_at, any other row has none.
    ...(state === "destroyed" ? { deleted_at: "2026-01-20T00:00:00Z" } : {}),
    config: JSON.stringify({
      region: "ap-southeast-1",
      sizeGb: 32,
      attachedInstanceId: attachedTo,
    }),
  });
  return { id, subscriptionId: await withSubscription(customerId, id, status) };
}

const opsOf = (resourceId: string) =>
  t.pool
    .query<{ kind: string; idempotency_key: string; payload: Record<string, unknown> }>(
      "select kind, idempotency_key, payload from operations where resource_id = $1 order by created_at, id",
      [resourceId],
    )
    .then((r) => r.rows);
const markOf = (resourceId: string) =>
  t.pool
    .query<{ mark: unknown }>(
      "select config -> 'retainedWithServer' as mark from resources where id = $1",
      [resourceId],
    )
    .then((r) => r.rows[0]?.mark ?? null);
const statusOf = (resourceId: string) =>
  t.pool
    .query<{ status: string }>("select status from subscriptions where resource_id = $1", [
      resourceId,
    ])
    .then((r) => r.rows[0]?.status);

it("the customer's destroy of a server retains its attached disks and queues their final snapshot and destroy", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const attached = await disk(a, srv);
  const free = await disk(a, null);
  const w = await as(a, (r) =>
    r.subscriptions.requestDestroy({
      resourceId: srv,
      idempotencyKey: "d1",
      withFinalSnapshot: true,
    }),
  );
  expect(w).toMatchObject({ ok: true, replayed: false });
  expect(await statusOf(attached.id)).toBe("retained");
  const ops = await opsOf(attached.id);
  expect(ops.map((o) => o.kind)).toEqual(["final_snapshot", "destroy"]);
  expect(ops.map((o) => o.idempotency_key)).toEqual([
    lifecycleOperationKey("final_snapshot", attached.subscriptionId, new Date(PERIOD_END)),
    lifecycleOperationKey("destroy", attached.subscriptionId, new Date(PERIOD_END)),
  ]);
  expect(ops[1]?.payload).toEqual({
    subscriptionId: attached.subscriptionId,
    withServer: srv,
    from: "active",
  });
  // web_rw writes no mark (it may not update resources); the payload carries the server and the former status.
  expect(await markOf(attached.id)).toBeNull();
  // A disk that is not attached to the server is not touched.
  expect(await statusOf(free.id)).toBe("active");
  expect(await opsOf(free.id)).toEqual([]);
});

it("the keys are the lifecycle engine's own: lifecycle:<kind>:<subscription>:<period end>", () => {
  expect(
    lifecycleOperationKey(
      "final_snapshot",
      "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
      new Date("2026-01-31T00:00:00Z"),
    ),
  ).toBe("lifecycle:final-snapshot:0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee:2026-01-31T00:00:00.000Z");
});

it("is idempotent: a second run replays the stored rows and adds none (R7)", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const attached = await disk(a, srv);
  const first = await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date()),
  );
  const second = await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date()),
  );
  expect(first.map((o) => o.created)).toEqual([true, true]);
  expect(second.map((o) => o.created)).toEqual([false, false]);
  expect(second.map((o) => o.operationId)).toEqual(first.map((o) => o.operationId));
  expect(await opsOf(attached.id)).toHaveLength(2);
});

it("leaves an ended, a destroyed and a failed disk alone", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const ended = await disk(a, srv, "ended");
  const destroyed = await disk(a, srv, "retained", "destroyed");
  const failed = await disk(a, srv, "active", "failed");
  const out = await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date()),
  );
  expect(out).toEqual([]);
  expect(await statusOf(ended.id)).toBe("ended");
  expect(await statusOf(failed.id)).toBe("active");
  expect(await opsOf(destroyed.id)).toEqual([]);
});

it("cross-tenant (R8): a disk of another customer whose config names the server is never touched", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const srv = await server(a);
  const foreign = await disk(b, srv);
  await as(a, (r) =>
    r.subscriptions.requestDestroy({
      resourceId: srv,
      idempotencyKey: "d2",
      withFinalSnapshot: true,
    }),
  );
  expect(await statusOf(foreign.id)).toBe("active");
  expect(await opsOf(foreign.id)).toEqual([]);
  // B's destroy of A's server is not_found and retains nothing.
  const srv2 = await server(a);
  const mine = await disk(a, srv2);
  expect(
    await as(b, (r) =>
      r.subscriptions.requestDestroy({
        resourceId: srv2,
        idempotencyKey: "d3",
        withFinalSnapshot: true,
      }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(await statusOf(mine.id)).toBe("active");
  expect(await opsOf(mine.id)).toEqual([]);
});

it("refuses ids that are not UUIDs before any statement (R16)", async () => {
  await expect(
    worker((tx) => retainAttachedDisks(tx, { customerId: "x", serverId: "y" }, new Date())),
  ).rejects.toThrow(TypeError);
});

// WPU-Y4 fix round 2: the mark of the worker path, the list a revival reads, and the server status the guard reads.
it("markConfig writes retainedWithServer = { serverId, from } once; a disk retained on its own is marked from retained", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const graceDisk = await disk(a, srv, "grace");
  const ownDisk = await disk(a, srv, "retained");
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date(), { markConfig: true }),
  );
  expect(await markOf(graceDisk.id)).toEqual({ serverId: srv, from: "grace" });
  expect(await markOf(ownDisk.id)).toEqual({ serverId: srv, from: "retained" });
  // A replay keeps the first mark (the disk is retained now, its former status is the mark's).
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date(), { markConfig: true }),
  );
  expect(await markOf(graceDisk.id)).toEqual({ serverId: srv, from: "grace" });
  const listed = await worker((tx) =>
    listDisksRetainedWithServer(tx, { customerId: a, serverId: srv }),
  );
  expect(new Map(listed.map((d) => [d.diskId, d.from]))).toEqual(
    new Map([
      [graceDisk.id, "grace"],
      [ownDisk.id, "retained"],
    ]),
  );
  await worker((tx) => clearRetainedWithServer(tx, { customerId: a, diskId: graceDisk.id }));
  expect(await markOf(graceDisk.id)).toBeNull();
});

it("a web-path cascade (no mark) is still found by the payload, with the former status of the payload", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const attached = await disk(a, srv);
  await as(a, (r) =>
    r.subscriptions.requestDestroy({
      resourceId: srv,
      idempotencyKey: "w1",
      withFinalSnapshot: true,
    }),
  );
  const listed = await worker((tx) =>
    listDisksRetainedWithServer(tx, { customerId: a, serverId: srv }),
  );
  expect(listed).toEqual([
    {
      diskId: attached.id,
      subscriptionId: attached.subscriptionId,
      status: "retained",
      from: "active",
    },
  ]);
  // Then the engine replays the cascade with the mark: the former status comes from the payload, not "retained".
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date(), { markConfig: true }),
  );
  expect(await markOf(attached.id)).toEqual({ serverId: srv, from: "active" });
});

it("cross-tenant (R8): the list, the server status for a disk and the attached server status read one customer only", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const srvA = await server(a);
  const srvB = await server(b);
  const diskA = await disk(a, srvA);
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srvA }, new Date(), { markConfig: true }),
  );
  expect(
    await worker((tx) => listDisksRetainedWithServer(tx, { customerId: b, serverId: srvA })),
  ).toEqual([]);
  expect(await worker((tx) => serverStatusForDisk(tx, { diskId: diskA.id, serverId: srvA }))).toBe(
    "active",
  );
  // B's server is never the server of A's disk: null, so the guard refuses.
  expect(
    await worker((tx) => serverStatusForDisk(tx, { diskId: diskA.id, serverId: srvB })),
  ).toBeNull();
  expect(await worker((tx) => attachedServerStatus(tx, { customerId: a, serverId: srvA }))).toBe(
    "active",
  );
  expect(
    await worker((tx) => attachedServerStatus(tx, { customerId: b, serverId: srvA })),
  ).toBeNull();
});

// WPU-Y4 fix round 4 (A): a key whose stored operation ended is no answer for a retention that starts now.
it("insertFreshOperation moves past an ended row to <key>:after:<id>, replays a live one, and is a replay itself", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const d = await disk(a, srv);
  const key = `test:fresh:${d.id}`;
  const input = { resourceId: d.id, kind: "destroy" as const, payload: {}, idempotencyKey: key };
  const first = await worker((tx) => insertFreshOperation(tx, input, new Date()));
  expect(first.created).toBe(true);
  // A live row is replayed.
  const live = await worker((tx) => insertFreshOperation(tx, input, new Date()));
  expect(live).toMatchObject({ created: false, operationId: first.operationId });
  // Ended: a new row under <key>:after:<id>; a repeat replays it (R7).
  await t.pool.query("update operations set state = 'failed' where id = $1", [first.operationId]);
  const second = await worker((tx) => insertFreshOperation(tx, input, new Date()));
  expect(second.created).toBe(true);
  const keyOf = async (id: string) =>
    (
      await t.pool.query<{ k: string }>(
        "select idempotency_key as k from operations where id = $1",
        [id],
      )
    ).rows[0]?.k;
  expect(await keyOf(second.operationId)).toBe(`${key}:after:${first.operationId}`);
  const again = await worker((tx) => insertFreshOperation(tx, input, new Date()));
  expect(again).toMatchObject({ created: false, operationId: second.operationId });
  // Ended again: the chain goes on from the base key.
  await t.pool.query("update operations set state = 'succeeded' where id = $1", [
    second.operationId,
  ]);
  const third = await worker((tx) => insertFreshOperation(tx, input, new Date()));
  expect(await keyOf(third.operationId)).toBe(`${key}:after:${second.operationId}`);
});

it("a disk retained again after its earlier retention was released gets a live destroy (no dead replay)", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const d = await disk(a, srv);
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date(), { markConfig: true }),
  );
  // The release: operations cancelled, status back, mark gone.
  await t.pool.query("update operations set state = 'failed' where resource_id = $1", [d.id]);
  await t.pool.query("update subscriptions set status = 'active' where resource_id = $1", [d.id]);
  await worker((tx) => clearRetainedWithServer(tx, { customerId: a, diskId: d.id }));
  await worker((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date(), { markConfig: true }),
  );
  const live = await t.pool.query(
    "select kind from operations where resource_id = $1 and state not in ('failed', 'succeeded') order by created_at, id",
    [d.id],
  );
  expect(live.rows.map((r) => r.kind)).toEqual(["final_snapshot", "destroy"]);
});

// WPU-Y4 fix round 4 (C): only a destroy that has not ended counts, and the payload branch needs the disk attached.
it("listDisksRetainedWithServer ignores ended destroys and disks no longer attached to the server", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const other = await server(a);
  // A disk retained on its own (no mark) whose only destroy naming srv is a failed row of an earlier episode.
  const historic = await disk(a, srv, "retained");
  await t.pool.query(
    `insert into operations (id, resource_id, kind, state, idempotency_key, payload)
     values (gen_random_uuid(), $1, 'destroy', 'failed', $2, $3::jsonb)`,
    [historic.id, `test:old:${historic.id}`, JSON.stringify({ withServer: srv, from: "active" })],
  );
  // A disk moved to another server whose live destroy still names srv.
  const moved = await disk(a, other, "retained");
  await t.pool.query(
    `insert into operations (id, resource_id, kind, state, idempotency_key, payload)
     values (gen_random_uuid(), $1, 'destroy', 'needs_approval', $2, $3::jsonb)`,
    [moved.id, `test:moved:${moved.id}`, JSON.stringify({ withServer: srv, from: "active" })],
  );
  const listed = await worker((tx) =>
    listDisksRetainedWithServer(tx, { customerId: a, serverId: srv }),
  );
  expect(listed).toEqual([]);
});

it("recordDiskHeld writes an attention item with ids and fixed words only", async () => {
  const a = await newCustomer(t.pool);
  const srv = await server(a);
  const d = await disk(a, srv);
  await worker((tx) => recordDiskHeld(tx, { diskId: d.id, serverId: srv }));
  const rows = await t.pool.query<{ kind: string; details: Record<string, unknown> }>(
    "select kind, details from discrepancies where details ->> 'resourceId' = $1",
    [d.id],
  );
  expect(rows.rows).toEqual([
    {
      kind: "missing",
      details: {
        resourceId: d.id,
        serverId: srv,
        reason: "disk_destroy_may_have_run",
        source: "attached_disks",
      },
    },
  ]);
});
