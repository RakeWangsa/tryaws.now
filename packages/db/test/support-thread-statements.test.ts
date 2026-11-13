import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { supportMessageId, supportRepo } from "../repositories/customer/support";
import { SUPPORT_THREAD_LIMIT, messageBody } from "../repositories/support-thread";

// WPU-Z5: the thread methods of customerRepos(tx, id).support, without a database. A fake transaction
// renders every statement the repository sends (PgDialect) and answers from a small world, so these cases
// run where PostgreSQL cannot: refusals before any statement, the exact statements, every statement bound to
// the customer of the scope (R8), the replay and the conflict of R7. The grants and the real rows are proven
// against PostgreSQL in support-repo.test.ts and in the cross-tenant cases (test/cross-tenant-cases/support.ts).

const dialect = new PgDialect();
const CUSTOMER = "0191a000-0000-7000-8000-0000000000c1";
const REQUEST = "0191a000-0000-7000-8000-0000000000e1";
const KEY = "0191a000-0000-4000-8000-0000000000aa";
const AT = new Date("2026-11-13T06:00:00.000Z");

interface Sent {
  readonly sql: string;
  readonly params: unknown[];
}

interface Message {
  id: string;
  author_type: string;
  body: string;
  created_at: Date;
}

interface World {
  /** The status of the request when it is the customer's; undefined: missing or another customer's. */
  status: string | undefined;
  /** A message already stored under the derived id (the replay case). */
  existing: { request_id: string; author_type: string; body: string } | undefined;
  /** The replies of the thread, latest first, as the database orders them. */
  latestFirst: Message[];
}

function rig(over: Partial<World> = {}) {
  const world: World = { status: "answered", existing: undefined, latestFirst: [], ...over };
  const sent: Sent[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      const text = rendered.sql.replace(/\s+/g, " ").trim();
      sent.push({ sql: text, params: rendered.params });
      if (text.startsWith("select status from support_requests")) {
        return { rows: world.status === undefined ? [] : [{ status: world.status }] };
      }
      if (text.startsWith("insert into support_messages")) {
        const rows = world.existing === undefined ? [{ id: rendered.params[0] }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith("select m.request_id")) {
        return { rows: world.existing === undefined ? [] : [world.existing] };
      }
      if (text.startsWith("select id, category, subject")) {
        return {
          rows:
            world.status === undefined
              ? []
              : [
                  {
                    id: REQUEST,
                    category: "billing",
                    subject: "Charged twice",
                    message: "I was charged twice.",
                    status: world.status,
                    created_at: AT,
                    last_activity_at: AT,
                  },
                ],
        };
      }
      if (text.startsWith("select m.id, m.author_type")) {
        const limit = Number(rendered.params[rendered.params.length - 1]);
        return { rows: world.latestFirst.slice(0, limit) };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Tx;
  return { sent, repo: supportRepo({ tx, customerId: CUSTOMER }) };
}

const kindOf = (s: Sent): string =>
  s.sql.startsWith("select status from support_requests")
    ? "lock"
    : s.sql.startsWith("insert into support_messages")
      ? "insert"
      : s.sql.startsWith("select m.request_id")
        ? "existing"
        : s.sql.startsWith("update support_requests")
          ? "update"
          : s.sql.startsWith("select id, category, subject")
            ? "request"
            : s.sql.startsWith("select m.id, m.author_type")
              ? "messages"
              : "other";

// R8: every statement carries the customer of the scope as a bound parameter, never in its text.
const expectScoped = (sent: readonly Sent[]) => {
  for (const s of sent) {
    expect(s.params, s.sql).toContain(CUSTOMER);
    expect(s.sql).not.toContain(CUSTOMER);
  }
};

const NOT_FOUND = { ok: false, error: "not_found" };
const VALIDATION = { ok: false, error: "validation" };
const CONFLICT = { ok: false, error: "conflict" };

describe("messageBody: the text of a message as it is stored", () => {
  it("keeps the text, turns CRLF into LF and trims; refuses empty, blank, too long and non-text", () => {
    expect(messageBody("  Hello\r\nagain  ")).toBe("Hello\nagain");
    expect(messageBody("x".repeat(5000))).toBe("x".repeat(5000));
    expect(messageBody(` ${"x".repeat(5000)}\r\n`)).toBe("x".repeat(5000));
    for (const bad of ["", "   ", "\r\n", "x".repeat(5001), 5, null, undefined, {}]) {
      expect(messageBody(bad), JSON.stringify(bad)?.slice(0, 12)).toBeNull();
    }
  });
});

describe("customerRepos.support.addMessage", () => {
  const input = (over: Record<string, unknown> = {}) =>
    ({ requestId: REQUEST, idempotencyKey: KEY, body: "  Any news?\r\nThanks  ", ...over }) as {
      requestId: string;
      idempotencyKey: string;
      body: string;
    };

  it("the id is a UUID v5 of the key in the namespace of the customer (the rule of create)", () => {
    expect(supportMessageId(CUSTOMER, KEY)).toBe(uuidv5(KEY, CUSTOMER));
    expect(supportMessageId(CUSTOMER, KEY)).not.toBe(
      supportMessageId("0191a000-0000-7000-8000-0000000000c2", KEY),
    );
  });

  it("adds a customer message to the customer's own request, under its lock, and opens the request", async () => {
    const r = rig({ status: "answered" });
    const id = supportMessageId(CUSTOMER, KEY);
    expect(await r.repo.addMessage(input())).toEqual({ ok: true, replayed: false, value: { id } });
    expect(r.sent.map(kindOf)).toEqual(["lock", "insert", "update"]);
    expect(r.sent[0]).toEqual({
      sql: "select status from support_requests where id = $1 and customer_id = $2 for update",
      params: [REQUEST, CUSTOMER],
    });
    expect(r.sent[1]).toEqual({
      sql: "insert into support_messages (id, request_id, author_type, body) select $1, r.id, 'customer', $2 from support_requests r where r.id = $3 and r.customer_id = $4 on conflict (id) do nothing returning id",
      params: [id, "Any news?\nThanks", REQUEST, CUSTOMER],
    });
    expect(r.sent[2]).toEqual({
      sql: "update support_requests set status = 'open', last_activity_at = now() where id = $1 and customer_id = $2",
      params: [REQUEST, CUSTOMER],
    });
    expectScoped(r.sent);
  });

  it("a reply reopens a closed request the same way", async () => {
    const r = rig({ status: "closed" });
    expect(await r.repo.addMessage(input())).toMatchObject({ ok: true, replayed: false });
    expect(r.sent.map(kindOf)).toEqual(["lock", "insert", "update"]);
    expect(r.sent[2]?.sql).toContain("set status = 'open', last_activity_at = now()");
  });

  it("another customer's request, a missing one and an id that is no UUID are one answer: not_found (R8)", async () => {
    const r = rig({ status: undefined });
    expect(await r.repo.addMessage(input())).toEqual(NOT_FOUND);
    expect(r.sent.map(kindOf)).toEqual(["lock"]);
    for (const requestId of ["x", "", 7, null]) {
      const bad = rig();
      expect(await bad.repo.addMessage(input({ requestId }))).toEqual(NOT_FOUND);
      expect(bad.sent).toEqual([]);
    }
  });

  it("refuses a blank, too long or non-text body and a bad key before any statement", async () => {
    const bad = [
      input({ body: "   " }),
      input({ body: "\r\n" }),
      input({ body: "x".repeat(5001) }),
      input({ body: 5 }),
      input({ idempotencyKey: "" }),
      input({ idempotencyKey: "has space" }),
      input({ idempotencyKey: "k".repeat(129) }),
      input({ idempotencyKey: 7 }),
    ];
    for (const request of bad) {
      const r = rig();
      expect(await r.repo.addMessage(request)).toEqual(VALIDATION);
      expect(r.sent).toEqual([]);
    }
  });

  it("the same key and text again is a replay that changes nothing (R7)", async () => {
    const r = rig({
      existing: { request_id: REQUEST, author_type: "customer", body: "Any news?\nThanks" },
    });
    expect(await r.repo.addMessage(input())).toEqual({
      ok: true,
      replayed: true,
      value: { id: supportMessageId(CUSTOMER, KEY) },
    });
    expect(r.sent.map(kindOf)).toEqual(["lock", "insert", "existing"]);
    expect(r.sent[2]).toEqual({
      sql: "select m.request_id, m.author_type, m.body from support_messages m join support_requests r on r.id = m.request_id where m.id = $1 and r.customer_id = $2",
      params: [supportMessageId(CUSTOMER, KEY), CUSTOMER],
    });
    expectScoped(r.sent);
  });

  it("the same key with other text, or for another request, is a conflict; an unreadable key row too (R16)", async () => {
    const cases: World["existing"][] = [
      { request_id: REQUEST, author_type: "customer", body: "Other text" },
      {
        request_id: "0191a000-0000-7000-8000-0000000000e9",
        author_type: "customer",
        body: "Any news?\nThanks",
      },
      undefined,
    ];
    for (const existing of cases) {
      const r = rig({ existing });
      if (existing === undefined) {
        // The insert found a row under the key, and the read finds none of this customer.
        const tx = {
          execute: async (query: SQL) => {
            const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, " ").trim();
            if (text.startsWith("select status")) return { rows: [{ status: "open" }] };
            return { rows: [], rowCount: 0 };
          },
        } as unknown as Tx;
        expect(await supportRepo({ tx, customerId: CUSTOMER }).addMessage(input())).toEqual(
          CONFLICT,
        );
        continue;
      }
      expect(await r.repo.addMessage(input()), JSON.stringify(existing)).toEqual(CONFLICT);
      expect(r.sent.map(kindOf)).toEqual(["lock", "insert", "existing"]);
    }
  });
});

describe("customerRepos.support.close", () => {
  it("closes the customer's own request under its lock", async () => {
    const r = rig({ status: "answered" });
    expect(await r.repo.close(REQUEST)).toEqual({
      ok: true,
      replayed: false,
      value: { id: REQUEST },
    });
    expect(r.sent.map(kindOf)).toEqual(["lock", "update"]);
    expect(r.sent[1]).toEqual({
      sql: "update support_requests set status = 'closed' where id = $1 and customer_id = $2",
      params: [REQUEST, CUSTOMER],
    });
    expectScoped(r.sent);
  });

  it("a closed request is a replay with no write", async () => {
    const r = rig({ status: "closed" });
    expect(await r.repo.close(REQUEST)).toEqual({
      ok: true,
      replayed: true,
      value: { id: REQUEST },
    });
    expect(r.sent.map(kindOf)).toEqual(["lock"]);
  });

  it("another customer's request, a missing one and a malformed id are not_found", async () => {
    const r = rig({ status: undefined });
    expect(await r.repo.close(REQUEST)).toEqual(NOT_FOUND);
    expect(r.sent.map(kindOf)).toEqual(["lock"]);
    const bad = rig();
    expect(await bad.repo.close("nope")).toEqual(NOT_FOUND);
    expect(bad.sent).toEqual([]);
  });
});

describe("customerRepos.support.thread", () => {
  const message = (n: number, author = "admin"): Message => ({
    id: `0191a000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    author_type: author,
    body: `reply ${n}`,
    created_at: new Date(AT.getTime() + n * 60_000),
  });

  it("answers the request and its replies oldest first, without any admin id", async () => {
    const r = rig({ status: "answered", latestFirst: [message(2), message(1, "customer")] });
    expect(await r.repo.thread(REQUEST)).toEqual({
      ok: true,
      replayed: false,
      value: {
        id: REQUEST,
        category: "billing",
        subject: "Charged twice",
        status: "answered",
        createdAt: AT,
        lastActivityAt: AT,
        message: "I was charged twice.",
        messages: [
          {
            id: message(1).id,
            authorType: "customer",
            body: "reply 1",
            createdAt: message(1).created_at,
          },
          {
            id: message(2).id,
            authorType: "admin",
            body: "reply 2",
            createdAt: message(2).created_at,
          },
        ],
        hasEarlier: false,
      },
    });
    expect(r.sent.map(kindOf)).toEqual(["request", "messages"]);
    expect(r.sent[0]).toEqual({
      sql: "select id, category, subject, message, status, created_at, last_activity_at from support_requests where id = $1 and customer_id = $2",
      params: [REQUEST, CUSTOMER],
    });
    expect(r.sent[1]).toEqual({
      sql: "select m.id, m.author_type, m.body, m.created_at from support_messages m join support_requests r on r.id = m.request_id where m.request_id = $1 and r.customer_id = $2 order by m.created_at desc, m.id desc limit $3",
      params: [REQUEST, CUSTOMER, SUPPORT_THREAD_LIMIT + 1],
    });
    expectScoped(r.sent);
    expect(JSON.stringify(await r.repo.thread(REQUEST))).not.toMatch(/admin_?id/i);
  });

  it("a long thread answers the latest replies, oldest first, and says that earlier ones exist", async () => {
    const latestFirst = Array.from({ length: SUPPORT_THREAD_LIMIT + 1 }, (_, i) =>
      message(SUPPORT_THREAD_LIMIT + 1 - i),
    );
    const out = await rig({ latestFirst }).repo.thread(REQUEST);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.hasEarlier).toBe(true);
    expect(out.value.messages).toHaveLength(SUPPORT_THREAD_LIMIT);
    expect(out.value.messages[0]?.body).toBe("reply 2");
    expect(out.value.messages.at(-1)?.body).toBe(`reply ${SUPPORT_THREAD_LIMIT + 1}`);
  });

  it("another customer's request, a missing one and a malformed id are not_found, with no read of messages", async () => {
    const r = rig({ status: undefined, latestFirst: [message(1)] });
    expect(await r.repo.thread(REQUEST)).toEqual(NOT_FOUND);
    expect(r.sent.map(kindOf)).toEqual(["request"]);
    const bad = rig();
    expect(await bad.repo.thread("../x")).toEqual(NOT_FOUND);
    expect(bad.sent).toEqual([]);
  });
});
