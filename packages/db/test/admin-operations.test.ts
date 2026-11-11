import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const AT = new Date("2030-01-01T00:00:00.000Z");
let resourceId = "";
let actor: AdminActor;
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
beforeAll(async () => {
  resourceId = await newResource(t.pool, await newCustomer(t.pool));
  actor = { adminId: await newAdmin(t.pool, "ops"), role: "ops", ip: "203.0.113.9" };
});
const seed = (state: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state,
    idempotency_key: "a:" + uniqueSuffix(),
    ...over,
  });
const state = async (id: string) =>
  (await t.pool.query("select state, approved_by from operations where id = $1", [id])).rows[0];

it("approve queues the operation, returns the message and appends one audit row with the target", async () => {
  const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
  const out = await asAdmin(actor, (r) =>
    r.operations.approve({ operationId: id, at: AT }, "customer asked by phone"),
  );
  expect(out).toEqual({
    ok: true,
    replayed: false,
    value: { message: { operationId: id, resourceId, enqueueSeq: 1 } },
  });
  expect(await state(id)).toEqual({ state: "queued", approved_by: actor.adminId });
  const rows = (await auditRowsOf(t.pool, actor.adminId)).filter((x) => x.target_id === id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "operation.approve",
    target_type: "operation",
    ip: "203.0.113.9",
  });
  expect(rows[0]?.metadata.reason).toBe("customer asked by phone");
});

it("a refusal (unknown id, wrong state) appends no audit row", async () => {
  const before = (await auditRowsOf(t.pool, actor.adminId)).length;
  expect(
    await asAdmin(actor, (r) => r.operations.approve({ operationId: uuidv7(), at: AT }, "x")),
  ).toEqual({ ok: false, error: "not_found" });
  const running = await seed("running");
  expect(
    await asAdmin(actor, (r) => r.operations.retry({ operationId: running, at: AT }, "x")),
  ).toEqual({ ok: false, error: "conflict" });
  expect((await auditRowsOf(t.pool, actor.adminId)).length).toBe(before);
});

it("retry of an operation that needs attention queues it", async () => {
  const id = await seed("needs_attention");
  const out = await asAdmin(actor, (r) => r.operations.retry({ operationId: id, at: AT }, "fixed"));
  expect(out).toMatchObject({ ok: true, replayed: false });
  expect((await state(id)).state).toBe("queued");
});

it("reject of a waiting operation fails it and sends no message", async () => {
  const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
  const out = await asAdmin(actor, (r) =>
    r.operations.reject({ operationId: id, at: AT }, "not wanted"),
  );
  expect(out).toEqual({ ok: true, replayed: false, value: { message: null } });
  expect((await state(id)).state).toBe("failed");
});

it("a disabled admin cannot approve: forbidden, the operation stays waiting", async () => {
  const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
  const gone = await newAdmin(t.pool, "ops");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [gone]);
  const out = await asAdmin({ adminId: gone, role: "ops", ip: "203.0.113.9" }, (r) =>
    r.operations.approve({ operationId: id, at: AT }, "x"),
  );
  expect(out).toEqual({ ok: false, error: "forbidden" });
  expect((await state(id)).state).toBe("needs_approval");
});

it("a bad id or time is a validation failure", async () => {
  expect(
    await asAdmin(actor, (r) =>
      r.operations.approve({ operationId: 5 as unknown as string, at: AT }, "x"),
    ),
  ).toEqual({ ok: false, error: "validation" });
  expect(
    await asAdmin(actor, (r) =>
      r.operations.approve({ operationId: uuidv7(), at: new Date("nope") }, "x"),
    ),
  ).toEqual({ ok: false, error: "validation" });
});
