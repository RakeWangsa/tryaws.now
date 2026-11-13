import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { supportMessageId, supportRequestId } from "../repositories/customer/support";
import { withCustomerRepos } from "../testing/repos";
import { newAdmin, newCustomer, newResource } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// 16.10 /support when signed in: createSupportRequest (WP9-T4b), as web_rw (grants of 0006).
const t = useTempDatabase();
const as = <T>(customerId: string, fn: Parameters<typeof withCustomerRepos<T>>[2]) =>
  withCustomerRepos(t.db, customerId, fn);

const request = (over: Record<string, unknown> = {}) => ({
  category: "billing",
  subject: "Charged twice",
  message: "I was charged twice.",
  relatedResourceId: null as string | null,
  idempotencyKey: "key-" + Math.random().toString(36).slice(2, 12),
  ...over,
});
const count = async (customerId: string) =>
  (
    await t.pool.query("select count(*)::int as n from support_requests where customer_id = $1", [
      customerId,
    ])
  ).rows[0].n as number;

it("creates an open request for the session's customer with the derived id", async () => {
  const customer = await newCustomer(t.pool);
  const input = request();
  const out = await as(customer, (r) => r.support.create(input));
  expect(out).toEqual({
    ok: true,
    value: { id: supportRequestId(customer, input.idempotencyKey) },
    replayed: false,
  });
  const row = (
    await t.pool.query(
      "select customer_id, status, category, subject, message, email from support_requests where id = $1",
      [out.ok ? out.value.id : ""],
    )
  ).rows[0];
  expect(row).toMatchObject({
    customer_id: customer,
    status: "open",
    category: "billing",
    subject: "Charged twice",
    email: null,
  });
});

it("the same key and text again is a replay and adds no row; the same key with other text is a conflict (R7)", async () => {
  const customer = await newCustomer(t.pool);
  const input = request();
  await as(customer, (r) => r.support.create(input));
  const again = await as(customer, (r) => r.support.create(input));
  expect(again.ok && again.replayed).toBe(true);
  const other = await as(customer, (r) => r.support.create({ ...input, message: "Other text." }));
  expect(other).toEqual({ ok: false, error: "conflict" });
  expect(await count(customer)).toBe(1);
});

it("the same key of two customers gives two requests (the id includes the customer)", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const input = request();
  const first = await as(a, (r) => r.support.create(input));
  const second = await as(b, (r) => r.support.create(input));
  expect(first.ok && !first.replayed && second.ok && !second.replayed).toBe(true);
  expect(first.ok && second.ok && first.value.id !== second.value.id).toBe(true);
});

it("a related resource of the customer is stored; another customer's, a missing and a malformed one are not_found (R8)", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const own = await newResource(t.pool, a);
  const theirs = await newResource(t.pool, b);
  const ok = await as(a, (r) => r.support.create(request({ relatedResourceId: own })));
  expect(ok.ok).toBe(true);
  for (const id of [theirs, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const out = await as(a, (r) => r.support.create(request({ relatedResourceId: id })));
    expect(out).toEqual({ ok: false, error: "not_found" });
  }
  expect(await count(a)).toBe(1);
});

it("list shows the customer's own requests, newest activity first, with no message and no other customer's", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const first = await as(a, (r) => r.support.create(request({ subject: "first" })));
  await as(a, (r) => r.support.create(request({ subject: "second" })));
  await as(b, (r) => r.support.create(request({ subject: "other customer" })));
  const rows = await as(a, (r) => r.support.list());
  expect(rows.map((x) => x.subject)).toEqual(["second", "first"]);
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "category",
    "createdAt",
    "id",
    "lastActivityAt",
    "status",
    "subject",
  ]);
  expect(rows[0]?.lastActivityAt).toBeInstanceOf(Date);
  expect(await as(a, (r) => r.support.list(1))).toHaveLength(1);
  // WPU-Z5: a reply on the first request moves it to the top.
  const id = first.ok ? first.value.id : "";
  await as(a, (r) =>
    r.support.addMessage({ requestId: id, idempotencyKey: key(), body: "Any news?" }),
  );
  expect((await as(a, (r) => r.support.list())).map((x) => x.subject)).toEqual(["first", "second"]);
});

// ---------------------------------------------------------------------------------------------
// WPU-Z5: the thread of a request (thread, addMessage, close), as web_rw (grants of 0027).

const key = () => "key-" + Math.random().toString(36).slice(2, 12);
async function ownRequest(customer: string): Promise<string> {
  const out = await as(customer, (r) => r.support.create(request()));
  if (!out.ok) throw new Error("seed: the request was not created");
  return out.value.id;
}
const stored = async (id: string) =>
  (
    await t.pool.query(
      "select status, last_activity_at, created_at from support_requests where id = $1",
      [id],
    )
  ).rows[0] as { status: string; last_activity_at: Date; created_at: Date };
const messagesOf = async (id: string) =>
  (
    await t.pool.query(
      "select id, author_type, admin_id, body from support_messages where request_id = $1 order by created_at, id",
      [id],
    )
  ).rows;

it("thread answers the request and its replies oldest first; the customer never sees an admin id", async () => {
  const a = await newCustomer(t.pool);
  const id = await ownRequest(a);
  const admin = await newAdmin(t.pool, "support");
  await t.pool.query(
    "insert into support_messages (id, request_id, author_type, admin_id, body, created_at) values ($1, $2, 'admin', $3, 'We refunded it.', now() - interval '1 minute')",
    [uuidv7(), id, admin],
  );
  await as(a, (r) =>
    r.support.addMessage({ requestId: id, idempotencyKey: key(), body: "Thanks!" }),
  );
  const out = await as(a, (r) => r.support.thread(id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toMatchObject({
    id,
    category: "billing",
    subject: "Charged twice",
    message: "I was charged twice.",
    status: "open",
    hasEarlier: false,
  });
  expect(out.value.messages.map((m) => [m.authorType, m.body])).toEqual([
    ["admin", "We refunded it."],
    ["customer", "Thanks!"],
  ]);
  expect(JSON.stringify(out.value)).not.toContain(admin);
  expect(Object.keys(out.value.messages[0]!).sort()).toEqual([
    "authorType",
    "body",
    "createdAt",
    "id",
  ]);
});

it("thread of another customer's request, a missing one and a malformed id is not_found (R8)", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await ownRequest(a);
  for (const requestId of [id, uuidv7(), "not-a-uuid"]) {
    expect(await as(b, (r) => r.support.thread(requestId))).toEqual({
      ok: false,
      error: "not_found",
    });
  }
});

it("addMessage stores the customer's reply with the derived id, opens an answered request and moves its last activity", async () => {
  const a = await newCustomer(t.pool);
  const id = await ownRequest(a);
  await t.pool.query(
    "update support_requests set status = 'answered', last_activity_at = now() - interval '1 day' where id = $1",
    [id],
  );
  const k = key();
  const out = await as(a, (r) =>
    r.support.addMessage({
      requestId: id,
      idempotencyKey: k,
      body: "  Still broken\r\nsince today  ",
    }),
  );
  expect(out).toEqual({ ok: true, replayed: false, value: { id: supportMessageId(a, k) } });
  expect(await messagesOf(id)).toEqual([
    {
      id: supportMessageId(a, k),
      author_type: "customer",
      admin_id: null,
      body: "Still broken\nsince today",
    },
  ]);
  const row = await stored(id);
  expect(row.status).toBe("open");
  expect(row.last_activity_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

it("a reply reopens a closed request", async () => {
  const a = await newCustomer(t.pool);
  const id = await ownRequest(a);
  await t.pool.query("update support_requests set status = 'closed' where id = $1", [id]);
  expect(
    await as(a, (r) =>
      r.support.addMessage({ requestId: id, idempotencyKey: key(), body: "Again" }),
    ),
  ).toMatchObject({ ok: true, replayed: false });
  expect((await stored(id)).status).toBe("open");
});

it("addMessage: the same key and text is a replay, other text under the key is a conflict (R7)", async () => {
  const a = await newCustomer(t.pool);
  const id = await ownRequest(a);
  const k = key();
  const send = (body: string) =>
    as(a, (r) => r.support.addMessage({ requestId: id, idempotencyKey: k, body }));
  expect(await send("Hello")).toMatchObject({ ok: true, replayed: false });
  expect(await send(" Hello ")).toMatchObject({ ok: true, replayed: true });
  expect(await send("Other text")).toEqual({ ok: false, error: "conflict" });
  expect(await messagesOf(id)).toHaveLength(1);
  // the same key of another customer is another message
  const b = await newCustomer(t.pool);
  const other = await ownRequest(b);
  expect(
    await as(b, (r) =>
      r.support.addMessage({ requestId: other, idempotencyKey: k, body: "Hello" }),
    ),
  ).toMatchObject({ ok: true, replayed: false });
});

it("addMessage refuses a blank or too long text (validation) and another customer's request (not_found), writing nothing", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await ownRequest(a);
  const before = await stored(id);
  for (const body of ["", "   ", "x".repeat(5001)]) {
    expect(
      await as(a, (r) => r.support.addMessage({ requestId: id, idempotencyKey: key(), body })),
    ).toEqual({ ok: false, error: "validation" });
  }
  for (const requestId of [id, uuidv7(), "x"]) {
    expect(
      await as(b, (r) => r.support.addMessage({ requestId, idempotencyKey: key(), body: "Hi" })),
    ).toEqual({ ok: false, error: "not_found" });
  }
  expect(await messagesOf(id)).toEqual([]);
  expect(await stored(id)).toEqual(before);
});

it("close closes the customer's own request once; a second close is a replay; another customer's is not_found", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await ownRequest(a);
  expect(await as(b, (r) => r.support.close(id))).toEqual({ ok: false, error: "not_found" });
  expect((await stored(id)).status).toBe("open");
  expect(await as(a, (r) => r.support.close(id))).toEqual({
    ok: true,
    replayed: false,
    value: { id },
  });
  expect((await stored(id)).status).toBe("closed");
  expect(await as(a, (r) => r.support.close(id))).toEqual({
    ok: true,
    replayed: true,
    value: { id },
  });
  expect(await as(a, (r) => r.support.close("nope"))).toEqual({ ok: false, error: "not_found" });
});
