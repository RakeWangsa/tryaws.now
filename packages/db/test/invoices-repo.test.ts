import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newOrder } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);

const lines = [{ kind: "service", code: "aws", amountMinor: "100" }] as const;
const input = (orderId: string, fiscalYear = 2026) => ({
  id: uuidv7(),
  orderId,
  fiscalYear,
  lines,
  totalMinor: 100n,
});

it("numbers invoices 1, 2, 3 within a fiscal year and restarts in the next", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const numbers: number[] = [];
  for (const [customer, year] of [
    [a, 2031],
    [b, 2031],
    [a, 2031],
    [b, 2032],
  ] as const) {
    const order = await newOrder(t.pool, customer);
    const w = await as(customer, (r) => r.invoices.issue(input(order, year)));
    if (!w.ok) throw new Error("issue refused");
    numbers.push(w.value.number);
  }
  expect(numbers).toEqual([1, 2, 3, 1]);
});

it("a rolled-back issue takes no number: no gap", async () => {
  const a = await newCustomer(t.pool);
  const o1 = await newOrder(t.pool, a);
  const o2 = await newOrder(t.pool, a);
  await expect(
    as(a, async (r) => {
      await r.invoices.issue(input(o1, 2033));
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  const w = await as(a, (r) => r.invoices.issue(input(o2, 2033)));
  expect(w).toMatchObject({ ok: true, value: { number: 1 } });
});

it("is idempotent per order: the second call returns the first invoice and takes no number", async () => {
  const a = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const first = await as(a, (r) => r.invoices.issue(input(order, 2034)));
  const second = await as(a, (r) => r.invoices.issue(input(order, 2034)));
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(second).toMatchObject({ ok: true, replayed: true });
  if (!first.ok || !second.ok) throw new Error("refused");
  expect(second.value.id).toBe(first.value.id);
  const other = await newOrder(t.pool, a);
  expect(await as(a, (r) => r.invoices.issue(input(other, 2034)))).toMatchObject({
    ok: true,
    value: { number: 2 },
  });
});

it("two concurrent issues get two different numbers", async () => {
  const a = await newCustomer(t.pool);
  const [o1, o2] = [await newOrder(t.pool, a), await newOrder(t.pool, a)];
  const results = await Promise.all([
    as(a, (r) => r.invoices.issue(input(o1, 2035))),
    as(a, (r) => r.invoices.issue(input(o2, 2035))),
  ]);
  const numbers = results.map((w) => (w.ok ? w.value.number : -1)).sort();
  expect(numbers).toEqual([1, 2]);
});

it("refuses a total that is not the total of the order, and an order of another customer", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  expect(await as(a, (r) => r.invoices.issue({ ...input(order, 2036), totalMinor: 7n }))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(await as(b, (r) => r.invoices.issue(input(order, 2036)))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(a, (r) => r.invoices.issue({ ...input(order, 2036), fiscalYear: 1999 }))).toEqual(
    {
      ok: false,
      error: "validation",
    },
  );
});

it("lists newest first in pages that do not skip or repeat a row", async () => {
  const a = await newCustomer(t.pool);
  for (let i = 0; i < 5; i++) {
    const order = await newOrder(t.pool, a);
    await as(a, (r) => r.invoices.issue(input(order, 2037)));
  }
  const p1 = await as(a, (r) => r.invoices.list({ limit: 2 }));
  expect(p1.items.map((i) => i.number)).toEqual([5, 4]);
  const p2 = await as(a, (r) => r.invoices.list({ limit: 2, after: p1.next! }));
  expect(p2.items.map((i) => i.number)).toEqual([3, 2]);
  const p3 = await as(a, (r) => r.invoices.list({ limit: 2, after: p2.next! }));
  expect(p3.items.map((i) => i.number)).toEqual([1]);
  expect(p3.next).toBeNull();
});

it("B cannot read, find or list the invoice of A", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const w = await as(a, (r) => r.invoices.issue(input(order, 2038)));
  if (!w.ok) throw new Error("refused");
  expect(await as(b, (r) => r.invoices.get(w.value.id))).toBeNull();
  expect(await as(b, (r) => r.invoices.findByOrder(order))).toBeNull();
  expect((await as(b, (r) => r.invoices.list())).items).toEqual([]);
});
