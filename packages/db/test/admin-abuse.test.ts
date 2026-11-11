import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /abuse: openAbuseCase, notes, suspendResource and closeAbuseCase for `ops` and `support`
// (suspendResource for ops and superadmin only). WP8-T7.
const t = useTempDatabase();
const AT = new Date("2030-01-01T00:00:00.000Z");
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});

async function seedResource(over: Record<string, unknown> = {}): Promise<string> {
  return newResource(t.pool, await newCustomer(t.pool), { state: "active", ...over });
}
async function seedCase(over: Record<string, unknown> = {}): Promise<{ id: string; res: string }> {
  const res = (over["resource_id"] as string | undefined) ?? (await seedResource());
  const id = await insertRow(t.pool, "abuse_cases", {
    resource_id: res,
    source: "third_party_report",
    ...over,
  });
  return { id, res };
}
const caseRow = async (id: string) =>
  (await t.pool.query("select status, notes, resource_id from abuse_cases where id = $1", [id]))
    .rows[0];
const opsOf = async (resourceId: string) =>
  (
    await t.pool.query(
      "select kind, state, needs_approval, idempotency_key, payload from operations where resource_id = $1 order by created_at",
      [resourceId],
    )
  ).rows;

it("openAbuseCase creates the case for a resource and audits it with the resource as context", async () => {
  const a = await actorOf("support");
  const res = await seedResource();
  const caseId = uuidv7();
  const out = await asAdmin(a, (r) =>
    r.abuse.open(
      { caseId, resourceId: res, source: "provider_notice", notes: "Mail from the provider." },
      "notice received",
    ),
  );
  expect(out).toEqual({ ok: true, replayed: false, value: { caseId, resourceId: res } });
  expect(await caseRow(caseId)).toEqual({
    status: "open",
    notes: "Mail from the provider.",
    resource_id: res,
  });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "abuse.open",
    target_type: "abuse_case",
    target_id: caseId,
    ip: "203.0.113.9",
  });
  expect(audit[0]?.metadata).toMatchObject({
    reason: "notice received",
    after: { resourceId: res, source: "provider_notice" },
  });
});

it("openAbuseCase with the same case id is a replay; another resource under that id is a conflict (R7)", async () => {
  const a = await actorOf();
  const res = await seedResource();
  const caseId = uuidv7();
  const open = (resourceId: string) =>
    asAdmin(a, (r) => r.abuse.open({ caseId, resourceId, source: "monitoring" }, "alert"));
  expect(await open(res)).toMatchObject({ ok: true, replayed: false });
  expect(await open(res)).toMatchObject({ ok: true, replayed: true });
  expect(await open(await seedResource())).toEqual({ ok: false, error: "conflict" });
  expect((await t.pool.query("select 1 from abuse_cases where id = $1", [caseId])).rowCount).toBe(
    1,
  );
  expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(2);
});

it("openAbuseCase validates the input and needs an existing resource", async () => {
  const a = await actorOf();
  const res = await seedResource();
  const good = { caseId: uuidv7(), resourceId: res, source: "monitoring" as const };
  const bad = [
    { ...good, caseId: "x" },
    { ...good, resourceId: "x" },
    { ...good, source: "gossip" as unknown as "monitoring" },
    { ...good, notes: 5 as unknown as string },
    { ...good, notes: "a".repeat(2001) },
  ];
  for (const input of bad) {
    expect(await asAdmin(a, (r) => r.abuse.open(input, "alert"))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await asAdmin(a, (r) => r.abuse.open(good, "  "))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.abuse.open({ ...good, resourceId: uuidv7() }, "alert"))).toEqual(
    {
      ok: false,
      error: "not_found",
    },
  );
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});

it("list and detail show the case with its resource and customer; finance is refused", async () => {
  const a = await actorOf("support");
  const { id, res } = await seedCase({ notes: "first" });
  const closed = await seedCase({ status: "closed" });
  const list = await asAdmin(a, (r) => r.abuse.list({ status: "open", limit: 100 }));
  expect(list.ok).toBe(true);
  if (!list.ok) return;
  expect(list.value.rows.map((x) => x.id)).toContain(id);
  expect(list.value.rows.map((x) => x.id)).not.toContain(closed.id);
  const row = list.value.rows.find((x) => x.id === id);
  expect(row).toMatchObject({
    resourceId: res,
    family: "linux_instance",
    resourceState: "active",
    source: "third_party_report",
    status: "open",
    notes: "first",
  });
  expect(typeof row?.customerId).toBe("string");
  const one = await asAdmin(a, (r) => r.abuse.detail(id));
  expect(one.ok && one.value.id).toBe(id);
  expect(await asAdmin(a, (r) => r.abuse.detail("x"))).toEqual({ ok: false, error: "not_found" });
  const fin = await actorOf("finance");
  expect(await asAdmin(fin, (r) => r.abuse.list({}))).toEqual({ ok: false, error: "forbidden" });
  expect(await asAdmin(fin, (r) => r.abuse.detail(id))).toEqual({ ok: false, error: "forbidden" });
  expect(
    await asAdmin(fin, (r) =>
      r.abuse.open({ caseId: uuidv7(), resourceId: res, source: "monitoring" }, "x"),
    ),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await auditRowsOf(t.pool, fin.adminId)).toEqual([]);
});

it("addNote appends a line with the day and the admin; the same note id is a replay", async () => {
  const a = await actorOf("support");
  const { id } = await seedCase({ notes: "first" });
  const noteId = uuidv7();
  const add = () =>
    asAdmin(a, (r) =>
      r.abuse.addNote({ caseId: id, noteId, note: "Called the customer.", at: AT }, "follow-up"),
    );
  expect(await add()).toEqual({ ok: true, replayed: false, value: { caseId: id, noteId } });
  const after = (await caseRow(id))?.notes as string;
  expect(after.startsWith("first\n")).toBe(true);
  expect(after).toContain(`[${noteId}] 2030-01-01 ${a.adminId.slice(0, 8)}: Called the customer.`);
  expect(await add()).toMatchObject({ ok: true, replayed: true });
  expect(((await caseRow(id))?.notes as string).split("Called the customer.")).toHaveLength(2);
  expect(
    await asAdmin(a, (r) =>
      r.abuse.addNote({ caseId: id, noteId: uuidv7(), note: " ", at: AT }, "x"),
    ),
  ).toEqual({ ok: false, error: "validation" });
});

it("a closed case takes no new note and closes only once", async () => {
  const a = await actorOf();
  const { id } = await seedCase();
  expect(await asAdmin(a, (r) => r.abuse.close({ caseId: id, at: AT }, "false alarm"))).toEqual({
    ok: true,
    replayed: false,
    value: { caseId: id, status: "closed" },
  });
  expect((await caseRow(id))?.status).toBe("closed");
  expect(await asAdmin(a, (r) => r.abuse.close({ caseId: id, at: AT }, "again"))).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(
    await asAdmin(a, (r) =>
      r.abuse.addNote({ caseId: id, noteId: uuidv7(), note: "late", at: AT }, "x"),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await asAdmin(a, (r) => r.abuse.close({ caseId: uuidv7(), at: AT }, "x"))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("suspendResource writes one operation row of kind suspend that waits for no approval and sends no AWS call (R1, R13)", async () => {
  const a = await actorOf("ops");
  const { id, res } = await seedCase();
  const out = await asAdmin(a, (r) =>
    r.abuse.suspendResource({ caseId: id, at: AT }, "spam from the server"),
  );
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.replayed).toBe(false);
  const rows = await opsOf(res);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "suspend",
    state: "queued",
    needs_approval: false,
    idempotency_key: `abuse-suspend:${id}`,
  });
  expect(rows[0].payload).toMatchObject({ adminSuspended: true, abuseCaseId: id });
  expect(out.value.message).toMatchObject({ resourceId: res });
  expect(typeof out.value.message?.operationId).toBe("string");
  // The resource row itself is not touched by the admin: the provisioner changes its state.
  expect(
    (await t.pool.query("select state from resources where id = $1", [res])).rows[0].state,
  ).toBe("active");
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "abuse.suspend_resource",
    target_type: "abuse_case",
    target_id: id,
  });
  expect(audit[0]?.metadata.reason).toBe("spam from the server");
});

it("suspendResource again is a replay with no second operation and no message to send (R7)", async () => {
  const a = await actorOf("ops");
  const { id, res } = await seedCase();
  const go = () => asAdmin(a, (r) => r.abuse.suspendResource({ caseId: id, at: AT }, "spam"));
  const first = await go();
  const again = await go();
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(again).toMatchObject({ ok: true, replayed: true, value: { message: null } });
  expect(await opsOf(res)).toHaveLength(1);
});

it("suspendResource is refused for support and finance, on a closed case and on a resource that is not active or stopped", async () => {
  const { id, res } = await seedCase();
  for (const role of ["support", "finance"] as const) {
    const a = await actorOf(role);
    expect(await asAdmin(a, (r) => r.abuse.suspendResource({ caseId: id, at: AT }, "x"))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
  }
  const ops = await actorOf("ops");
  const closed = await seedCase({ status: "closed" });
  expect(
    await asAdmin(ops, (r) => r.abuse.suspendResource({ caseId: closed.id, at: AT }, "x")),
  ).toEqual({
    ok: false,
    error: "conflict",
  });
  const gone = await seedCase({ resource_id: await seedResource({ state: "suspended" }) });
  expect(
    await asAdmin(ops, (r) => r.abuse.suspendResource({ caseId: gone.id, at: AT }, "x")),
  ).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(
    await asAdmin(ops, (r) => r.abuse.suspendResource({ caseId: id, at: new Date("x") }, "x")),
  ).toEqual({
    ok: false,
    error: "validation",
  });
  expect(
    await asAdmin(ops, (r) => r.abuse.suspendResource({ caseId: uuidv7(), at: AT }, "x")),
  ).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await opsOf(res)).toEqual([]);
  expect(await auditRowsOf(t.pool, ops.adminId)).toEqual([]);
});

it("a disabled admin is refused on every call and nothing is written", async () => {
  const a = await actorOf("ops");
  const { id, res } = await seedCase();
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [a.adminId]);
  expect(await asAdmin(a, (r) => r.abuse.list({}))).toEqual({ ok: false, error: "forbidden" });
  expect(await asAdmin(a, (r) => r.abuse.suspendResource({ caseId: id, at: AT }, "x"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await asAdmin(a, (r) => r.abuse.close({ caseId: id, at: AT }, "x"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await opsOf(res)).toEqual([]);
  expect((await caseRow(id))?.status).toBe("open");
});
