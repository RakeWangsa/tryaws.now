import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import type { AdminActor, AdminRole } from "../repositories/admin/index";
import { supportAdminRepo, supportReplyMessageId } from "../repositories/admin/support";
import { SUPPORT_THREAD_LIMIT } from "../repositories/support-thread";

// WPU-Z5: the admin side of the support thread, without a database. A fake transaction renders every
// statement (PgDialect) and answers from a small world, so these cases run where PostgreSQL cannot: the
// refusals before any statement, the reply as one audited transaction (the admin message, the notification
// and the state), the text never in the audit row (R14), the replay by reply id (R7), close and reopen. The
// grants and the real rows are proven against PostgreSQL in admin-support.test.ts.

const dialect = new PgDialect();
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const CUSTOMER = "0191a000-0000-7000-8000-0000000000c1";
const REQUEST = "0191a000-0000-7000-8000-0000000000e1";
const REPLY = "0191a000-0000-4000-8000-0000000000f1";
const IP = "203.0.113.5";
const AT = new Date("2026-11-13T06:00:00.000Z");

interface Sent {
  readonly sql: string;
  readonly params: unknown[];
}

interface World {
  admin: { role: string; status: string } | null;
  /** The request; undefined when there is none. */
  request: { customer_id: string | null; email: string | null; status: string } | undefined;
  /** A message stored under the id of the reply (the replay case). */
  existing: { request_id: string; author_type: string; body: string } | undefined;
}

function rig(role: AdminRole = "support", over: Partial<World> = {}) {
  const world: World = {
    admin: { role, status: "active" },
    request: { customer_id: CUSTOMER, email: null, status: "open" },
    existing: undefined,
    ...over,
  };
  const sent: Sent[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      const text = rendered.sql.replace(/\s+/g, " ").trim();
      sent.push({ sql: text, params: rendered.params });
      if (text.startsWith("select role, status from admin_users")) {
        return { rows: world.admin === null ? [] : [world.admin] };
      }
      if (text.startsWith("select customer_id, email, status from support_requests")) {
        return { rows: world.request === undefined ? [] : [world.request] };
      }
      if (text.startsWith("select status, handled_by from support_requests")) {
        return {
          rows:
            world.request === undefined ? [] : [{ status: world.request.status, handled_by: null }],
        };
      }
      if (text.startsWith("select request_id, author_type, body from support_messages")) {
        return { rows: world.existing === undefined ? [] : [world.existing] };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Tx;
  const actor: AdminActor = { adminId: ADMIN_ID, role, ip: IP, userAgent: "test-agent" };
  return { sent, repo: supportAdminRepo({ tx, actor }) };
}

const kindOf = (s: Sent): string =>
  s.sql.startsWith("select role, status from admin_users")
    ? "admin"
    : s.sql.startsWith("select customer_id, email, status from support_requests") ||
        s.sql.startsWith("select status, handled_by from support_requests")
      ? "lock"
      : s.sql.startsWith("select request_id, author_type, body from support_messages")
        ? "existing"
        : s.sql.startsWith("insert into support_messages")
          ? "message"
          : s.sql.startsWith("insert into notifications")
            ? "notification"
            : s.sql.startsWith("update support_requests")
              ? "update"
              : s.sql.startsWith("insert into audit_log")
                ? "audit"
                : "other";
const auditOf = (sent: readonly Sent[]) => {
  const audit = sent.find((s) => kindOf(s) === "audit");
  expect(audit, "an audit row").toBeDefined();
  return audit as Sent;
};
const metadataOf = (audit: Sent): Record<string, unknown> =>
  JSON.parse(String(audit.params[8])) as Record<string, unknown>;

const FORBIDDEN = { ok: false, error: "forbidden" };
const VALIDATION = { ok: false, error: "validation" };
const CONFLICT = { ok: false, error: "conflict" };
const NOT_FOUND = { ok: false, error: "not_found" };
const reply = (over: Record<string, unknown> = {}) =>
  ({ requestId: REQUEST, replyId: REPLY, body: "  We refunded it.\r\nSorry.  ", ...over }) as {
    requestId: string;
    replyId: string;
    body: string;
  };

describe("supportAdminRepo.reply", () => {
  it("the message id is a UUID v5 of the reply id in the namespace of the request", () => {
    expect(supportReplyMessageId(REQUEST, REPLY)).toBe(uuidv5(REPLY, REQUEST));
    expect(supportReplyMessageId(REQUEST.toUpperCase(), REPLY.toUpperCase())).toBe(
      uuidv5(REPLY, REQUEST),
    );
  });

  it("writes the admin message, the notification and the answered state in one audited transaction", async () => {
    const r = rig();
    const messageId = supportReplyMessageId(REQUEST, REPLY);
    expect(await r.repo.reply(reply(), "reply")).toEqual({
      ok: true,
      replayed: false,
      value: { requestId: REQUEST, replyId: REPLY },
    });
    expect(r.sent.map(kindOf)).toEqual([
      "admin",
      "lock",
      "existing",
      "message",
      "notification",
      "update",
      "audit",
    ]);
    expect(r.sent[1]).toEqual({
      sql: "select customer_id, email, status from support_requests where id = $1 for update",
      params: [REQUEST],
    });
    expect(r.sent[2]).toEqual({
      sql: "select request_id, author_type, body from support_messages where id = $1",
      params: [messageId],
    });
    expect(r.sent[3]).toEqual({
      sql: "insert into support_messages (id, request_id, author_type, admin_id, body) values ($1, $2, 'admin', $3, $4)",
      params: [messageId, REQUEST, ADMIN_ID, "We refunded it.\nSorry."],
    });
    const notification = r.sent[4] as Sent;
    expect(notification.sql).toBe(
      "insert into notifications (id, customer_id, email, channel, template, payload, dedupe_key) values ($1, $2, $3, 'email', $4, $5::jsonb, $6) on conflict do nothing",
    );
    expect(notification.params.slice(1)).toEqual([
      CUSTOMER,
      null,
      "support_reply",
      JSON.stringify({ requestId: REQUEST, body: "We refunded it.\nSorry.", audience: "customer" }),
      `support-reply:${REQUEST}:${REPLY}`,
    ]);
    expect(r.sent[5]).toEqual({
      sql: "update support_requests set status = 'answered', last_activity_at = now(), handled_by = $1 where id = $2",
      params: [ADMIN_ID, REQUEST],
    });
    const audit = auditOf(r.sent);
    expect(audit.params.slice(1, 8)).toEqual([
      "admin",
      ADMIN_ID,
      "support.reply",
      "support_request",
      REQUEST,
      IP,
      "test-agent",
    ]);
    expect(metadataOf(audit)).toEqual({
      reason: "reply",
      before: { status: "open" },
      after: { status: "answered", replyId: REPLY, length: "We refunded it.\nSorry.".length },
    });
    // R14: the text of the reply is in the message and the notification, never in the audit row.
    expect(JSON.stringify(audit.params)).not.toContain("refunded");
  });

  it("a request of a visitor is answered at its address, with the text for a visitor", async () => {
    const r = rig("superadmin", {
      request: { customer_id: null, email: "visitor@example.test", status: "answered" },
    });
    expect(await r.repo.reply(reply(), "reply")).toMatchObject({ ok: true, replayed: false });
    const notification = r.sent.find((s) => kindOf(s) === "notification") as Sent;
    expect(notification.params.slice(1, 3)).toEqual([null, "visitor@example.test"]);
    expect(JSON.parse(String(notification.params[4]))).toEqual({
      requestId: REQUEST,
      body: "We refunded it.\nSorry.",
      audience: "visitor",
    });
  });

  it("the same reply id with the same text is a replay: nothing but the audit row is written (R7)", async () => {
    const r = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "closed" },
      existing: { request_id: REQUEST, author_type: "admin", body: "We refunded it.\nSorry." },
    });
    expect(await r.repo.reply(reply(), "reply")).toEqual({
      ok: true,
      replayed: true,
      value: { requestId: REQUEST, replyId: REPLY },
    });
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "existing", "audit"]);
  });

  it("the same reply id with another text is a conflict, and writes nothing", async () => {
    const r = rig("support", {
      existing: { request_id: REQUEST, author_type: "admin", body: "Another text" },
    });
    expect(await r.repo.reply(reply(), "reply")).toEqual(CONFLICT);
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "existing"]);
  });

  it("a closed request cannot be answered, a missing one is not_found: no write, no audit row", async () => {
    const closed = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "closed" },
    });
    expect(await closed.repo.reply(reply(), "reply")).toEqual(CONFLICT);
    expect(closed.sent.map(kindOf)).toEqual(["admin", "lock", "existing"]);
    const missing = rig("support", { request: undefined });
    expect(await missing.repo.reply(reply(), "reply")).toEqual(NOT_FOUND);
    expect(missing.sent.map(kindOf)).toEqual(["admin", "lock"]);
  });

  it("an answered request can be answered again", async () => {
    const r = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "answered" },
    });
    expect(await r.repo.reply(reply(), "reply")).toMatchObject({ ok: true, replayed: false });
    expect(r.sent.map(kindOf)).toContain("message");
  });

  it("ops and finance are refused before any statement; bad ids and texts before any statement too", async () => {
    for (const role of ["ops", "finance"] as const) {
      const r = rig(role);
      expect(await r.repo.reply(reply(), "reply")).toEqual(FORBIDDEN);
      expect(r.sent).toEqual([]);
    }
    for (const input of [
      reply({ requestId: "x" }),
      reply({ replyId: "x" }),
      reply({ body: "   " }),
      reply({ body: "\r\n" }),
      reply({ body: "a".repeat(5001) }),
      reply({ body: 5 }),
    ]) {
      const r = rig();
      expect(await r.repo.reply(input, "reply")).toEqual(VALIDATION);
      expect(r.sent).toEqual([]);
    }
  });

  it("a disabled admin stops at the admin check", async () => {
    const r = rig("support", { admin: { role: "support", status: "disabled" } });
    expect(await r.repo.reply(reply(), "reply")).toEqual(FORBIDDEN);
    expect(r.sent.map(kindOf)).toEqual(["admin"]);
  });
});

describe("supportAdminRepo.close and reopen", () => {
  it("close closes an answered request and keeps the first handler; a closed one is a replay", async () => {
    const r = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "answered" },
    });
    expect(await r.repo.close({ requestId: REQUEST }, "solved")).toEqual({
      ok: true,
      replayed: false,
      value: { requestId: REQUEST, status: "closed" },
    });
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "update", "audit"]);
    expect(r.sent[2]?.sql).toBe(
      "update support_requests set status = 'closed', handled_by = coalesce(handled_by, $1) where id = $2",
    );
    expect(metadataOf(auditOf(r.sent))).toEqual({
      reason: "solved",
      before: { status: "answered" },
      after: { status: "closed" },
    });
    const again = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "closed" },
    });
    expect(await again.repo.close({ requestId: REQUEST }, "again")).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(again.sent.map(kindOf)).toEqual(["admin", "lock", "audit"]);
  });

  it("reopen opens a closed request under its lock, through audited; an open one is a replay", async () => {
    const r = rig("superadmin", {
      request: { customer_id: CUSTOMER, email: null, status: "closed" },
    });
    expect(await r.repo.reopen({ requestId: REQUEST }, "customer called back")).toEqual({
      ok: true,
      replayed: false,
      value: { requestId: REQUEST, status: "open" },
    });
    expect(r.sent.map(kindOf)).toEqual(["admin", "lock", "update", "audit"]);
    expect(r.sent[1]?.sql).toBe(
      "select status, handled_by from support_requests where id = $1 for update",
    );
    expect(r.sent[2]).toEqual({
      sql: "update support_requests set status = 'open' where id = $1",
      params: [REQUEST],
    });
    const audit = auditOf(r.sent);
    expect(audit.params.slice(3, 6)).toEqual(["support.reopen", "support_request", REQUEST]);
    expect(metadataOf(audit)).toEqual({
      reason: "customer called back",
      before: { status: "closed" },
      after: { status: "open" },
    });
    const open = rig("support", {
      request: { customer_id: CUSTOMER, email: null, status: "open" },
    });
    expect(await open.repo.reopen({ requestId: REQUEST }, "again")).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(open.sent.map(kindOf)).toEqual(["admin", "lock", "audit"]);
  });

  it("reopen: other roles, a bad id, a blank reason and a missing request are refused, with no write", async () => {
    for (const role of ["ops", "finance"] as const) {
      const r = rig(role);
      expect(await r.repo.reopen({ requestId: REQUEST }, "r")).toEqual(FORBIDDEN);
      expect(r.sent).toEqual([]);
    }
    const bad = rig();
    expect(await bad.repo.reopen({ requestId: "x" }, "r")).toEqual(VALIDATION);
    expect(bad.sent).toEqual([]);
    const blank = rig();
    expect(await blank.repo.reopen({ requestId: REQUEST }, "  ")).toEqual(VALIDATION);
    expect(blank.sent.map(kindOf)).toEqual(["admin"]);
    const missing = rig("support", { request: undefined });
    expect(await missing.repo.reopen({ requestId: REQUEST }, "r")).toEqual(NOT_FOUND);
    expect(missing.sent.map(kindOf)).toEqual(["admin", "lock"]);
  });
});

describe("supportAdminRepo.detail and list", () => {
  function reader(messagesLatestFirst: Record<string, unknown>[]) {
    const sent: Sent[] = [];
    const tx = {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        const text = rendered.sql.replace(/\s+/g, " ").trim();
        sent.push({ sql: text, params: rendered.params });
        if (text.startsWith("select role, status from admin_users")) {
          return { rows: [{ role: "support", status: "active" }] };
        }
        if (text.includes("from support_requests s left join customers c")) {
          return {
            rows: [
              {
                id: REQUEST,
                customer_id: null,
                name: "Visitor",
                email: "visitor.name@example.test",
                customer_email: null,
                category: "billing",
                subject: "Charged twice",
                status: "answered",
                related_resource_id: null,
                handled_by: ADMIN_ID,
                created_at: AT,
                last_activity_at: AT,
                message: "Please help",
              },
            ],
          };
        }
        if (
          text.startsWith(
            "select id, author_type, admin_id, body, created_at from support_messages",
          )
        ) {
          return { rows: messagesLatestFirst };
        }
        return { rows: [] };
      },
    } as unknown as Tx;
    const actor: AdminActor = { adminId: ADMIN_ID, role: "support", ip: IP };
    return { sent, repo: supportAdminRepo({ tx, actor }) };
  }

  it("detail answers the thread oldest first, with the author type and the admin of each reply, the address masked", async () => {
    const later = new Date(AT.getTime() + 60_000);
    const r = reader([
      { id: "m2", author_type: "visitor", admin_id: null, body: "Thanks", created_at: later },
      { id: "m1", author_type: "admin", admin_id: ADMIN_ID, body: "Done", created_at: AT },
    ]);
    const out = await r.repo.detail(REQUEST);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({
      id: REQUEST,
      emailMasked: "v***@example.test",
      status: "answered",
      lastActivityAt: AT,
      message: "Please help",
      hasEarlier: false,
      messages: [
        { id: "m1", authorType: "admin", adminId: ADMIN_ID, body: "Done", createdAt: AT },
        { id: "m2", authorType: "visitor", adminId: null, body: "Thanks", createdAt: later },
      ],
    });
    expect(JSON.stringify(out.value)).not.toContain("visitor.name");
    const messages = r.sent.find((s) => s.sql.includes("from support_messages")) as Sent;
    expect(messages).toEqual({
      sql: "select id, author_type, admin_id, body, created_at from support_messages where request_id = $1 order by created_at desc, id desc limit $2",
      params: [REQUEST, SUPPORT_THREAD_LIMIT + 1],
    });
  });

  it("list filters by the three states, orders by the last activity and pages after a row of the list", async () => {
    const r = reader([]);
    expect(await r.repo.list({ status: "answered", after: REQUEST, limit: 10 })).toMatchObject({
      ok: true,
      value: { nextAfter: null },
    });
    const list = r.sent.find((s) =>
      s.sql.includes("from support_requests s left join customers c"),
    ) as Sent;
    expect(list.sql).toContain(
      "where true and s.status = $1 and (s.last_activity_at, s.id) < (select a.last_activity_at, a.id from support_requests a where a.id = $2) order by s.last_activity_at desc, s.id desc limit $3",
    );
    expect(list.params).toEqual(["answered", REQUEST, 11]);
    for (const status of ["open", "closed"] as const) {
      expect((await reader([]).repo.list({ status })).ok).toBe(true);
    }
    expect(await reader([]).repo.list({ status: "resolved" as never })).toEqual(VALIDATION);
  });
});
