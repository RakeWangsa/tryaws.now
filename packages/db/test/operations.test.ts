import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { useTempDatabase } from "./temp-db";
import { newCustomer, newResource } from "./fixtures";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const ops = async () =>
  (await t.pool.query("select count(*)::int as n from operations")).rows[0].n as number;

it("resources.list and resources.get show own resources without pool or AWS internals", async () => {
  const c = await newCustomer(t.pool);
  const id = await newResource(t.pool, c, { region: "ap-southeast-1" });
  const list = await as(c, (r) => r.resources.list());
  expect(list.map((x) => x.id)).toEqual([id]);
  expect(Object.keys(list[0]!).sort()).toEqual([
    "config",
    "createdAt",
    "deletedAt",
    "family",
    "id",
    "parentResourceId",
    "productId",
    "region",
    "state",
  ]);
  expect(await as(c, (r) => r.resources.get(id))).toMatchObject({
    id,
    family: "linux_instance",
    state: "creating",
  });
  expect(await as(c, (r) => r.resources.get("abc"))).toBeNull();
});

it("request queues an operation for an own resource, under the column grants of web_rw", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const r = await as(c, (x) =>
    x.operations.request({ resourceId, kind: "reboot", idempotencyKey: "k1" }),
  );
  expect(r).toMatchObject({
    ok: true,
    replayed: false,
    value: { resourceId, kind: "reboot", state: "queued", step: null, needsApproval: false },
  });
  // only the columns web_rw may read (migration 0006)
  expect(Object.keys(r.ok ? r.value : {}).sort()).toEqual([
    "createdAt",
    "id",
    "kind",
    "needsApproval",
    "resourceId",
    "state",
    "step",
  ]);
  const { rows } = await t.pool.query(
    "select idempotency_key from operations where resource_id = $1",
    [resourceId],
  );
  expect(rows).toEqual([{ idempotency_key: `customer:${c}:k1` }]);
});

it("an operation that needs approval waits in needs_approval (R13)", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  expect(
    await as(c, (x) =>
      x.operations.request({
        resourceId,
        kind: "destroy",
        idempotencyKey: "d1",
        needsApproval: true,
      }),
    ),
  ).toMatchObject({ ok: true, value: { state: "needs_approval", needsApproval: true } });
});

it("the same key again is a replay, also with another payload (web_rw cannot read it); with another resource, kind or approval it is a conflict", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const other = await newResource(t.pool, c);
  const req = { resourceId, kind: "reboot", idempotencyKey: "k2", payload: { a: 1, b: 2 } };
  const first = await as(c, (x) => x.operations.request(req));
  expect(await as(c, (x) => x.operations.request(req))).toEqual({
    ok: true,
    replayed: true,
    value: first.ok ? first.value : null,
  });
  expect(await as(c, (x) => x.operations.request({ ...req, resourceId: other }))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(await as(c, (x) => x.operations.request({ ...req, kind: "stop" }))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(await as(c, (x) => x.operations.request({ ...req, payload: { a: 2 } }))).toEqual({
    ok: true,
    replayed: true,
    value: first.ok ? first.value : null,
  });
  expect(await as(c, (x) => x.operations.request({ ...req, needsApproval: true }))).toEqual({
    ok: false,
    error: "conflict",
  });
});

it("a key of 0 or more than 128 characters is a validation failure", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  for (const idempotencyKey of ["", "k".repeat(129)]) {
    expect(
      await as(c, (x) => x.operations.request({ resourceId, kind: "reboot", idempotencyKey })),
    ).toEqual({ ok: false, error: "validation" });
  }
});

it("another customer's resource, a missing one and a non-UUID id are all not found, and nothing is inserted", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const ofA = await newResource(t.pool, a);
  const before = await ops();
  for (const resourceId of [ofA, uuidv7(), "abc"]) {
    expect(
      await as(b, (x) =>
        x.operations.request({ resourceId, kind: "reboot", idempotencyKey: "k3" }),
      ),
    ).toEqual({ ok: false, error: "not_found" });
  }
  expect(await ops()).toBe(before);
  expect(await as(b, (x) => x.operations.listForResource(ofA))).toEqual([]);
});

it("two customers may use the same client key", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  for (const c of [a, b]) {
    const resourceId = await newResource(t.pool, c);
    expect(
      await as(c, (x) =>
        x.operations.request({ resourceId, kind: "reboot", idempotencyKey: "same" }),
      ),
    ).toMatchObject({ ok: true, replayed: false });
  }
});

it("two requests with the same key at the same moment: one row, one created and one replayed", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const req = { resourceId, kind: "reboot", idempotencyKey: "race" };
  const results = await Promise.all([
    as(c, (x) => x.operations.request(req)),
    as(c, (x) => x.operations.request(req)),
  ]);
  expect(results.map((r) => (r.ok ? r.replayed : r.error)).sort()).toEqual([false, true]);
  const { rows } = await t.pool.query(
    "select count(*)::int as n from operations where resource_id = $1",
    [resourceId],
  );
  expect(rows[0].n).toBe(1);
});

it("get and listForResource read through the owner of the resource", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const r = await as(c, (x) =>
    x.operations.request({ resourceId, kind: "reboot", idempotencyKey: "g1" }),
  );
  const id = r.ok ? r.value.id : "";
  expect(await as(c, (x) => x.operations.get(id))).toMatchObject({ id, resourceId });
  expect((await as(c, (x) => x.operations.listForResource(resourceId))).map((o) => o.id)).toEqual([
    id,
  ]);
  expect(await as(c, (x) => x.operations.get("abc"))).toBeNull();
});

// The tests below pin what the brief says in prose and the tests above do not check.

it("resources.list gives every state, newest first, and a destroyed resource carries its deletedAt", async () => {
  const c = await newCustomer(t.pool);
  const active = await newResource(t.pool, c, { state: "active" });
  const destroyed = await newResource(t.pool, c, { state: "destroyed", deleted_at: new Date() });
  const failed = await newResource(t.pool, c, { state: "failed" });
  const list = await as(c, (r) => r.resources.list());
  expect(list.map((x) => [x.id, x.state])).toEqual([
    [failed, "failed"],
    [destroyed, "destroyed"],
    [active, "active"],
  ]);
  expect(list[0]!.deletedAt).toBeNull();
  expect(list[1]!.deletedAt).toBeInstanceOf(Date);
});

it("a raw row's createdAt is a valid Date; request, get and listForResource give equal rows, newest first", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const first = await as(c, (x) =>
    x.operations.request({ resourceId, kind: "reboot", idempotencyKey: "o1" }),
  );
  const second = await as(c, (x) =>
    x.operations.request({ resourceId, kind: "stop", idempotencyKey: "o2" }),
  );
  if (!first.ok || !second.ok) throw new Error("both requests should have been created");
  expect(first.value.createdAt).toBeInstanceOf(Date);
  expect(Number.isNaN(first.value.createdAt.getTime())).toBe(false);
  expect(await as(c, (x) => x.operations.get(second.value.id))).toEqual(second.value);
  expect(await as(c, (x) => x.operations.listForResource(resourceId))).toEqual([
    second.value,
    first.value,
  ]);
});

it("a replay inside a longer transaction does not abort it: the next statement of the same action works", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const req = { resourceId, kind: "reboot", idempotencyKey: "tx1" };
  const seen = await as(c, async (x) => {
    const first = await x.operations.request(req);
    const again = await x.operations.request(req);
    const list = await x.operations.listForResource(resourceId);
    return { first, again, list };
  });
  expect(seen.first).toMatchObject({ ok: true, replayed: false });
  expect(seen.again).toMatchObject({ ok: true, replayed: true });
  expect(seen.list).toHaveLength(1);
});

it("a key of exactly 128 characters is accepted", async () => {
  const c = await newCustomer(t.pool);
  const resourceId = await newResource(t.pool, c);
  const idempotencyKey = "k".repeat(128);
  expect(
    await as(c, (x) => x.operations.request({ resourceId, kind: "reboot", idempotencyKey })),
  ).toMatchObject({ ok: true, replayed: false });
});
