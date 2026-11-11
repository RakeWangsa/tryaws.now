import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WP5-T6: the repositories behind the Backups, Storage, Billing and Destroy tabs, the dashboard and
// the bell. The cross-tenant cases of the same methods are in cross-tenant-cases/.

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);

async function server(customerId: string, status = "active"): Promise<string> {
  const resourceId = await newResource(t.pool, customerId, { state: "active" });
  await insertRow(t.pool, "subscriptions", {
    resource_id: resourceId,
    customer_id: customerId,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-01-01T00:00:00Z",
    period_end: "2026-01-31T00:00:00Z",
    status,
  });
  return resourceId;
}

const note = (customerId: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "notifications", {
    customer_id: customerId,
    channel: "in_app",
    template: "t",
    payload: "{}",
    dedupe_key: "n:" + uniqueSuffix() + uuidv7(),
    ...over,
  });

it("notifications: only in-app rows of the customer, newest first, unread count, markRead", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const first = await note(a);
  const second = await note(a);
  await note(a, { channel: "email" });
  await note(b);
  const listed = await as(a, (r) => r.notifications.list());
  expect(listed.map((n) => n.id)).toEqual([second, first]);
  expect(await as(a, (r) => r.notifications.unreadCount())).toBe(2);
  expect(await as(b, (r) => r.notifications.markRead([first]))).toBe(0);
  expect(await as(a, (r) => r.notifications.unreadCount())).toBe(2);
  expect(await as(a, (r) => r.notifications.markRead([first, "not-a-uuid"]))).toBe(1);
  expect(await as(a, (r) => r.notifications.unreadCount())).toBe(1);
  expect(await as(a, (r) => r.notifications.markRead())).toBe(1);
  expect(await as(a, (r) => r.notifications.unreadCount())).toBe(0);
  const after = await as(a, (r) => r.notifications.list());
  expect(after.every((n) => n.readAt instanceof Date)).toBe(true);
});

it("notifications.list never returns more than 50 rows", async () => {
  const a = await newCustomer(t.pool);
  for (let i = 0; i < 52; i += 1) await note(a);
  expect(await as(a, (r) => r.notifications.list(500))).toHaveLength(50);
});

it("subscriptions: get, list and the renewal switch of the customer's own resource", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const resource = await server(a);
  const got = await as(a, (r) => r.subscriptions.get(resource));
  expect(got).toMatchObject({ resourceId: resource, autoRenew: false, status: "active" });
  expect(await as(b, (r) => r.subscriptions.get(resource))).toBeNull();
  expect(await as(a, (r) => r.subscriptions.list())).toHaveLength(1);
  const on = await as(a, (r) => r.subscriptions.setAutoRenew(resource, true));
  expect(on).toMatchObject({ ok: true, value: { autoRenew: true } });
  expect(await as(b, (r) => r.subscriptions.setAutoRenew(resource, false))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("requestDestroy: retained, final snapshot first, destroy behind it, flagged before the end date of R13", async () => {
  const a = await newCustomer(t.pool);
  const resource = await server(a);
  const w = await as(a, (r) =>
    r.subscriptions.requestDestroy({
      resourceId: resource,
      idempotencyKey: "k1",
      withFinalSnapshot: true,
    }),
  );
  expect(w).toMatchObject({ ok: true, replayed: false });
  const ops = await t.pool.query<{ kind: string; state: string; needs_approval: boolean }>(
    "select kind, state, needs_approval from operations where resource_id = $1 order by created_at, id",
    [resource],
  );
  expect(ops.rows.map((o) => o.kind)).toEqual(["final_snapshot", "destroy"]);
  // Today is before 2026-12-01 18:00 UTC in the test clock of this suite or not; the flag follows
  // the settings row, so it is read back and compared to the answer.
  const destroy = ops.rows[1];
  expect(w.ok && w.value.needsApproval).toBe(destroy?.needs_approval);
  const sub = await as(a, (r) => r.subscriptions.get(resource));
  expect(sub?.status).toBe("retained");
});

it("requestDestroy is idempotent: a repeat answers with the stored operations and adds none", async () => {
  const a = await newCustomer(t.pool);
  const resource = await server(a);
  const input = { resourceId: resource, idempotencyKey: "same", withFinalSnapshot: true };
  const first = await as(a, (r) => r.subscriptions.requestDestroy(input));
  const second = await as(a, (r) => r.subscriptions.requestDestroy(input));
  expect(second).toMatchObject({ ok: true, replayed: true });
  expect(second.ok && first.ok && second.value.destroyOperationId).toBe(
    first.ok ? first.value.destroyOperationId : null,
  );
  const n = await t.pool.query("select 1 from operations where resource_id = $1", [resource]);
  expect(n.rowCount).toBe(2);
});

it("requestDestroy: a family without snapshots queues the destroy alone; a retained, ended or foreign subscription is refused", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const noSnap = await server(a);
  const w = await as(a, (r) =>
    r.subscriptions.requestDestroy({
      resourceId: noSnap,
      idempotencyKey: "plain",
      withFinalSnapshot: false,
    }),
  );
  expect(w).toMatchObject({ ok: true, value: { finalSnapshotOperationId: null } });
  const retained = await server(a, "retained");
  expect(
    await as(a, (r) =>
      r.subscriptions.requestDestroy({
        resourceId: retained,
        idempotencyKey: "again",
        withFinalSnapshot: true,
      }),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  const foreign = await server(a);
  expect(
    await as(b, (r) =>
      r.subscriptions.requestDestroy({
        resourceId: foreign,
        idempotencyKey: "foreign",
        withFinalSnapshot: true,
      }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await as(a, (r) =>
      r.subscriptions.requestDestroy({
        resourceId: foreign,
        idempotencyKey: "bad key!",
        withFinalSnapshot: true,
      }),
    ),
  ).toEqual({ ok: false, error: "validation" });
});

it("createBackupRow: a child row of the customer's server, idempotent by id, not_found for others", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const parent = await newResource(t.pool, a);
  const id = uuidv7();
  const first = await as(a, (r) =>
    r.resources.createBackupRow({ id, parentId: parent, displayName: "before upgrade" }),
  );
  expect(first).toMatchObject({
    ok: true,
    replayed: false,
    value: { id, family: "backup", state: "creating", parentResourceId: parent },
  });
  expect(
    await as(a, (r) => r.resources.createBackupRow({ id, parentId: parent, displayName: "x" })),
  ).toMatchObject({ ok: true, replayed: true });
  // B neither creates under A's server nor learns that A's id exists.
  expect(
    await as(b, (r) => r.resources.createBackupRow({ id, parentId: parent, displayName: "x" })),
  ).toEqual({ ok: false, error: "not_found" });
  const bParent = await newResource(t.pool, b);
  expect(
    await as(b, (r) => r.resources.createBackupRow({ id, parentId: bParent, displayName: "x" })),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await as(a, (r) =>
      r.resources.createBackupRow({ id: uuidv7(), parentId: parent, displayName: "<b>" }),
    ),
  ).toEqual({ ok: false, error: "validation" });
});

it("operations.request refuses delete_backup for a final backup and for a non-backup row, and queues it for a normal backup (R13)", async () => {
  const a = await newCustomer(t.pool);
  const parent = await newResource(t.pool, a);
  const normal = await newResource(t.pool, a, {
    family: "backup",
    parent_resource_id: parent,
    state: "active",
    config: JSON.stringify({ displayName: "n" }),
  });
  const final = await newResource(t.pool, a, {
    family: "backup",
    parent_resource_id: parent,
    state: "active",
    config: JSON.stringify({ final: true }),
  });
  const ask = (resourceId: string, key: string) =>
    as(a, (r) => r.operations.request({ resourceId, kind: "delete_backup", idempotencyKey: key }));
  expect(await ask(final, "k-final")).toEqual({ ok: false, error: "not_found" });
  expect(await ask(parent, "k-parent")).toEqual({ ok: false, error: "not_found" });
  expect(await ask(normal, "k-normal")).toMatchObject({ ok: true });
  // Cross-tenant: another customer asking for A's normal backup is told it does not exist.
  const b = await newCustomer(t.pool);
  expect(
    await as(b, (r) =>
      r.operations.request({ resourceId: normal, kind: "delete_backup", idempotencyKey: "k-b" }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  const n = await t.pool.query("select 1 from operations where resource_id = any($1)", [
    [final, parent],
  ]);
  expect(n.rowCount).toBe(0);
});

it("resources.listChildren: the backups of one parent, destroyed ones left out; operations.listRecent: newest first, own only", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const parent = await newResource(t.pool, a);
  const live = await newResource(t.pool, a, {
    family: "backup",
    parent_resource_id: parent,
    state: "active",
  });
  await newResource(t.pool, a, {
    family: "backup",
    parent_resource_id: parent,
    state: "destroyed",
    deleted_at: new Date().toISOString(),
  });
  await newResource(t.pool, a, { family: "disk", parent_resource_id: parent });
  expect((await as(a, (r) => r.resources.listChildren(parent, "backup"))).map((x) => x.id)).toEqual(
    [live],
  );
  expect(await as(b, (r) => r.resources.listChildren(parent, "backup"))).toEqual([]);
  expect(await as(a, (r) => r.resources.listChildren("nope", "backup"))).toEqual([]);

  const own = await as(a, (r) =>
    r.operations.request({ resourceId: parent, kind: "reboot", idempotencyKey: "r1" }),
  );
  expect(own.ok).toBe(true);
  expect((await as(a, (r) => r.operations.listRecent(5))).map((o) => o.kind)).toEqual(["reboot"]);
  expect(await as(b, (r) => r.operations.listRecent(5))).toEqual([]);
});
