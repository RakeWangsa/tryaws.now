import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { lifecycleOperationKey, retainAttachedDisks } from "../repositories/system/attached-disks";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-Y4: a destroyed server takes its disks with it. The disks attached to a server (config.attachedInstanceId)
// are retained with it and get their own final snapshot and destroy, under the lifecycle engine's keys, for the
// server's customer only (R8), idempotently (R7).

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
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
  expect(ops[1]?.payload).toEqual({ subscriptionId: attached.subscriptionId, withServer: srv });
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
  const first = await t.db.transaction((tx) =>
    retainAttachedDisks(tx, { customerId: a, serverId: srv }, new Date()),
  );
  const second = await t.db.transaction((tx) =>
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
  const out = await t.db.transaction((tx) =>
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
    t.db.transaction((tx) =>
      retainAttachedDisks(tx, { customerId: "x", serverId: "y" }, new Date()),
    ),
  ).rejects.toThrow(TypeError);
});
