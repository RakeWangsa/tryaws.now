import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /support: replyByEmail and closeRequest for `support` (and superadmin). WP8-T7. WPU-Z5: the reply
// is a message of the thread (support_messages) and the request becomes `answered`; reopenRequest.
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
const thread = async (id: string) =>
  (
    await t.pool.query(
      "select author_type, admin_id, body from support_messages where request_id = $1 order by created_at, id",
      [id],
    )
  ).rows;
const lastActivity = async (id: string): Promise<Date> =>
  (await t.pool.query("select last_activity_at from support_requests where id = $1", [id])).rows[0]
    .last_activity_at;

it("list shows the requests with a masked address and filters by state", async () => {
  const a = await actorOf();
  const open = await seedRequest();
  const closed = await seedRequest({ status: "closed" });
  const answered = await seedRequest({ status: "answered" });
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
  expect(ids).not.toContain(answered);
  const row = out.value.rows.find((x) => x.id === visitor);
  expect(row?.emailMasked).toBe("v***@example.test");
  expect(row?.lastActivityAt).toBeInstanceOf(Date);
  expect(JSON.stringify(out.value)).not.toContain("visitor.name");
  expect(JSON.stringify(out.value)).not.toContain("rahim.uddin");
  const waiting = await asAdmin(a, (r) => r.support.list({ status: "answered", limit: 100 }));
  expect(waiting.ok && waiting.value.rows.map((x) => x.id)).toContain(answered);
  expect(waiting.ok && waiting.value.rows.map((x) => x.id)).not.toContain(open);
});

it("list: the newest activity first, and the next page starts after the last row of the page before", async () => {
  const a = await actorOf();
  const ids: string[] = [];
  for (const minutes of [30, 20, 10]) {
    const id = await seedRequest({ status: "closed" });
    await t.pool.query(
      "update support_requests set last_activity_at = now() + interval '1 day' - $2::int * interval '1 minute' where id = $1",
      [id, minutes],
    );
    ids.push(id);
  }
  // ids[2] is the newest activity, ids[0] the oldest of the three; they are newer than every other row.
  const first = await asAdmin(a, (r) => r.support.list({ status: "closed", limit: 2 }));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.rows.map((x) => x.id)).toEqual([ids[2], ids[1]]);
  expect(first.value.nextAfter).toBe(ids[1]);
  const second = await asAdmin(a, (r) =>
    r.support.list({ status: "closed", limit: 2, after: first.value.nextAfter ?? "" }),
  );
  expect(second.ok && second.value.rows[0]?.id).toBe(ids[0]);
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
  expect(out.value.messages).toEqual([]);
  expect(out.value.hasEarlier).toBe(false);
});

it("detail returns the whole thread oldest first: author type, the admin of an admin reply, the time", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  await asAdmin(a, (r) =>
    r.support.reply({ requestId: id, replyId: uuidv7(), body: "We refunded it." }, "reply"),
  );
  await t.pool.query(
    "insert into support_messages (id, request_id, author_type, body, created_at) values ($1, $2, 'customer', 'Thanks!', now() + interval '1 minute')",
    [uuidv7(), id],
  );
  const out = await asAdmin(a, (r) => r.support.detail(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value.messages.map((m) => [m.authorType, m.adminId, m.body])).toEqual([
    ["admin", a.adminId, "We refunded it."],
    ["customer", null, "Thanks!"],
  ]);
  expect(out.value.messages[0]?.createdAt).toBeInstanceOf(Date);
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

it("reply adds the admin message to the thread, queues one email notification for the customer, answers the request and audits without the text", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  await t.pool.query(
    "update support_requests set last_activity_at = now() - interval '1 day' where id = $1",
    [id],
  );
  const replyId = uuidv7();
  const out = await asAdmin(a, (r) =>
    r.support.reply({ requestId: id, replyId, body: "We refunded the second charge." }, "reply"),
  );
  expect(out).toEqual({ ok: true, replayed: false, value: { requestId: id, replyId } });
  expect(await thread(id)).toEqual([
    { author_type: "admin", admin_id: a.adminId, body: "We refunded the second charge." },
  ]);
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
    audience: "customer",
  });
  expect(await request(id)).toEqual({ status: "answered", handled_by: a.adminId });
  expect((await lastActivity(id)).getTime()).toBeGreaterThan(Date.now() - 60_000);
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
  expect(rows[0].payload).toEqual({ requestId: id, body: "Hello", audience: "visitor" });
  expect(await thread(id)).toEqual([{ author_type: "admin", admin_id: a.adminId, body: "Hello" }]);
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
  expect(await thread(id)).toHaveLength(1);
  // WPU-Z5: the same reply id with another text is refused, and nothing is written.
  expect(
    await asAdmin(a, (r) =>
      r.support.reply({ requestId: id, replyId, body: "Another text" }, "reply"),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await send(uuidv7())).toMatchObject({ ok: true, replayed: false });
  expect(await notifications(`support-reply:${id}:`)).toHaveLength(2);
  expect(await thread(id)).toHaveLength(2);
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

it("an answered request can be answered again; a reply sent before the close is still a replay after it", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  const replyId = uuidv7();
  await asAdmin(a, (r) => r.support.reply({ requestId: id, replyId, body: "First" }, "reply"));
  expect(
    await asAdmin(a, (r) =>
      r.support.reply({ requestId: id, replyId: uuidv7(), body: "Second" }, "reply"),
    ),
  ).toMatchObject({ ok: true, replayed: false });
  await asAdmin(a, (r) => r.support.close({ requestId: id }, "done"));
  expect(
    await asAdmin(a, (r) => r.support.reply({ requestId: id, replyId, body: "First" }, "reply")),
  ).toMatchObject({ ok: true, replayed: true });
  expect(await thread(id)).toHaveLength(2);
  expect((await request(id)).status).toBe("closed");
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

it("reopen opens a closed request, keeps the handler and the last activity, and the second reopen is a replay", async () => {
  const a = await actorOf();
  const id = await seedRequest();
  await asAdmin(a, (r) => r.support.close({ requestId: id }, "solved"));
  const before = await lastActivity(id);
  expect(await asAdmin(a, (r) => r.support.reopen({ requestId: id }, "customer called"))).toEqual({
    ok: true,
    replayed: false,
    value: { requestId: id, status: "open" },
  });
  expect(await request(id)).toEqual({ status: "open", handled_by: a.adminId });
  expect(await lastActivity(id)).toEqual(before);
  expect(await asAdmin(a, (r) => r.support.reopen({ requestId: id }, "again"))).toMatchObject({
    ok: true,
    replayed: true,
  });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit.map((x) => x.action)).toEqual(["support.close", "support.reopen", "support.reopen"]);
  expect(audit[1]?.metadata).toMatchObject({
    reason: "customer called",
    before: { status: "closed" },
    after: { status: "open" },
  });
  // A reopened request can be answered again.
  expect(
    await asAdmin(a, (r) =>
      r.support.reply({ requestId: id, replyId: uuidv7(), body: "Back" }, "reply"),
    ),
  ).toMatchObject({ ok: true, replayed: false });
});

it("reopen: ops and finance are refused, a bad id and a blank reason are validation, a missing request is not_found", async () => {
  const id = await seedRequest({ status: "closed" });
  for (const role of ["ops", "finance"] as const) {
    const a = await actorOf(role);
    expect(await asAdmin(a, (r) => r.support.reopen({ requestId: id }, "x"))).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  const a = await actorOf();
  expect(await asAdmin(a, (r) => r.support.reopen({ requestId: "x" }, "y"))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.support.reopen({ requestId: id }, "  "))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.support.reopen({ requestId: uuidv7() }, "y"))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect((await request(id)).status).toBe("closed");
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});
