import { expect, it } from "vitest";
import { supportRequestId } from "../repositories/customer/support";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource } from "./fixtures";
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

it("list shows the customer's own requests, newest first, with no message and no other customer's", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  await as(a, (r) => r.support.create(request({ subject: "first" })));
  await as(a, (r) => r.support.create(request({ subject: "second" })));
  await as(b, (r) => r.support.create(request({ subject: "other customer" })));
  const rows = await as(a, (r) => r.support.list());
  expect(rows.map((x) => x.subject)).toEqual(["second", "first"]);
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "category",
    "createdAt",
    "id",
    "status",
    "subject",
  ]);
  expect(await as(a, (r) => r.support.list(1))).toHaveLength(1);
});
