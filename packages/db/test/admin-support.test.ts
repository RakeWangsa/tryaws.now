import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /support: replyByEmail and closeRequest for `support` (and superadmin). WP8-T7.
const t = useTempDatabase();
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "support"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});

async function seedRequest(over: Record<string, unknown> = {}): Promise<string> {
  return insertRow(t.pool, "support_requests", {
    customer_id: await newCustomer(t.pool, { email: "rahim.uddin@example.test" }),
    category: "billing",
    subject: "Charged twice",
    message: "I was charged twice for the same server.",
    ...over,
  });
}
const notifications = async (key: string) =>
  (
    await t.pool.query(
      "select customer_id, email, channel, template, payload, status from notifications where dedupe_key like $1",
      [key + "%"],
    )
  ).rows;
const request = async (id: string) =>
  (await t.pool.query("select status, handled_by from support_requests where id = $1", [id]))
    .rows[0];

it("list shows the requests with a masked address and filters by state", async () => {
  const a = await actorOf();
  const open = await seedRequest();
  const closed = await seedRequest({ status: "closed" });
  const visitor = await seedRequest({
    customer_id: null,
    name: "Visitor",
    email: "visitor.name@example.test",
  });
  const out = await asAdmin(a, (r) => r.support.list({ status: "open", limit: 100 }));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const ids = out.value.rows.map((x) => x.id);
  expect(ids).toContain(open);
  expect(ids).toContain(visitor);
  expect(ids).not.toContain(closed);
  const row = out.value.rows.find((x) => x.id === visitor);
  expect(row?.emailMasked).toBe("v***@example.test");
  expect(JSON.stringify(out.value)).not.toContain("visitor.name");
  expect(JSON.stringify(out.value)).not.toContain("rahim.uddin");
});

it("detail returns the message and the masked address of a customer, and the audit trail of the request", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  await asAdmin(a, (r) => r.support.close({ requestId: id }, "answered by phone"));
  const out = await asAdmin(a, (r) => r.support.detail(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value.message).toBe("I was charged twice for the same server.");
  expect(out.value.emailMasked).toBe("r***@example.test");
  expect(out.value.audit.map((x) => [x.action, x.reason])).toEqual([
    ["support.close", "answered by phone"],
  ]);
});

it("an unknown or malformed id is not_found", async () => {
  const a = await actorOf();
  expect(await asAdmin(a, (r) => r.support.detail("nope"))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.support.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("only support and superadmin work here: ops and finance are refused on reads and writes, and no row changes", async () => {
  const id = await seedRequest();
  for (const role of ["ops", "finance"] as const) {
    const a = await actorOf(role);
    expect(await asAdmin(a, (r) => r.support.list({}))).toEqual({ ok: false, error: "forbidden" });
    expect(await asAdmin(a, (r) => r.support.detail(id))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await asAdmin(a, (r) =>
        r.support.reply({ requestId: id, replyId: uuidv7(), body: "Hello" }, "x"),
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await asAdmin(a, (r) => r.support.close({ requestId: id }, "x"))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
  }
  expect(await request(id)).toEqual({ status: "open", handled_by: null });
  const boss = await actorOf("superadmin");
  expect((await asAdmin(boss, (r) => r.support.list({}))).ok).toBe(true);
});

it("a disabled admin is refused on reads and writes", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [a.adminId]);
  expect(await asAdmin(a, (r) => r.support.list({}))).toEqual({ ok: false, error: "forbidden" });
  expect(await asAdmin(a, (r) => r.support.close({ requestId: id }, "x"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await request(id)).toEqual({ status: "open", handled_by: null });
});

it("reply queues one email notification for the customer, marks the handler and audits without the text", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  const replyId = uuidv7();
  const out = await asAdmin(a, (r) =>
    r.support.reply({ requestId: id, replyId, body: "We refunded the second charge." }, "reply"),
  );
  expect(out).toEqual({ ok: true, replayed: false, value: { requestId: id, replyId } });
  const rows = await notifications(`support-reply:${id}:${replyId}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    email: null,
    channel: "email",
    template: "support_reply",
    status: "pending",
  });
  expect(rows[0].customer_id).toBeTruthy();
  expect(rows[0].payload).toEqual({
    requestId: id,
    body: "We refunded the second charge.",
  });
  expect(await request(id)).toEqual({ status: "open", handled_by: a.adminId });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "support.reply",
    target_type: "support_request",
    target_id: id,
    ip: "203.0.113.9",
  });
  expect(audit[0]?.metadata.reason).toBe("reply");
  expect(JSON.stringify(audit[0]?.metadata)).not.toContain("refunded");
});

it("a reply to a visitor goes to the address of the request", async () => {
  const a = await actorOf();
  const id = await seedRequest({
    customer_id: null,
    name: "Visitor",
    email: "visitor@example.test",
  });
  const replyId = uuidv7();
  await asAdmin(a, (r) => r.support.reply({ requestId: id, replyId, body: "Hello" }, "reply"));
  const rows = await notifications(`support-reply:${id}:${replyId}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ customer_id: null, email: "visitor@example.test" });
});

it("the same reply id again is a replay: no second notification (R7); a new id is a second reply", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  const replyId = uuidv7();
  const send = (rid: string) =>
    asAdmin(a, (r) => r.support.reply({ requestId: id, replyId: rid, body: "Hello" }, "reply"));
  expect(await send(replyId)).toMatchObject({ ok: true, replayed: false });
  expect(await send(replyId)).toMatchObject({ ok: true, replayed: true });
  expect(await notifications(`support-reply:${id}:`)).toHaveLength(1);
  expect(await send(uuidv7())).toMatchObject({ ok: true, replayed: false });
  expect(await notifications(`support-reply:${id}:`)).toHaveLength(2);
});

it("reply validates the ids and the text before any write", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  const bad = [
    { requestId: "x", replyId: uuidv7(), body: "Hello" },
    { requestId: id, replyId: "x", body: "Hello" },
    { requestId: id, replyId: uuidv7(), body: "   " },
    { requestId: id, replyId: uuidv7(), body: "a".repeat(5001) },
    { requestId: id, replyId: uuidv7(), body: 5 as unknown as string },
  ];
  for (const input of bad) {
    expect(await asAdmin(a, (r) => r.support.reply(input, "reply"))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await asAdmin(a, (r) => r.support.reply({ ...bad[0]!, requestId: id }, ""))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await notifications(`support-reply:${id}:`)).toEqual([]);
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});

it("a closed request and a missing request cannot be answered and write no audit row", async () => {
  const a = await actorOf();
  const closed = await seedRequest({ status: "closed" });
  expect(
    await asAdmin(a, (r) =>
      r.support.reply({ requestId: closed, replyId: uuidv7(), body: "Hello" }, "reply"),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    await asAdmin(a, (r) =>
      r.support.reply({ requestId: uuidv7(), replyId: uuidv7(), body: "Hello" }, "reply"),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});

it("close closes the request once, names the handler, and the second close is a replay with its own audit row", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  expect(await asAdmin(a, (r) => r.support.close({ requestId: id }, "solved"))).toEqual({
    ok: true,
    replayed: false,
    value: { requestId: id, status: "closed" },
  });
  expect(await request(id)).toEqual({ status: "closed", handled_by: a.adminId });
  const other = await actorOf();
  expect(await asAdmin(other, (r) => r.support.close({ requestId: id }, "again"))).toMatchObject({
    ok: true,
    replayed: true,
  });
  // The first handler stays.
  expect(await request(id)).toEqual({ status: "closed", handled_by: a.adminId });
  expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(1);
  expect(await asAdmin(a, (r) => r.support.close({ requestId: id }, "  "))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.support.close({ requestId: "x" }, "y"))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.support.close({ requestId: uuidv7() }, "y"))).toEqual({
    ok: false,
    error: "not_found",
  });
});
