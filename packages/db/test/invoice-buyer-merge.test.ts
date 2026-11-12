import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newOrder, seedSeller } from "./fixtures";
import { asRole } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-I4: the invoice has both the seller snapshot (0016) and the buyer snapshot (0017). admin_rw reads
// every invoice column but buyer (the customer's BIN or NID and address).
const t = useTempDatabase();
beforeAll(async () => {
  await seedSeller(t.pool);
});
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);
const lines = [{ kind: "service", code: "aws", amountMinor: "100" }] as const;
const BUYER = {
  name: "Rahim Traders",
  address: "House 5, Dhaka",
  taxId: { kind: "bin", value: "1234567890123" },
} as const;

it("issue stores the seller and the buyer snapshot together, and a replay changes neither", async () => {
  const a = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const input = {
    id: uuidv7(),
    orderId: order,
    fiscalYear: 2051,
    lines,
    totalMinor: 100n,
    buyer: BUYER,
  };
  const first = await as(a, (r) => r.invoices.issue(input));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.buyer).toEqual(BUYER);
  expect(first.value.seller).not.toBeNull();
  const again = await as(a, (r) => r.invoices.issue({ ...input, buyer: null }));
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect((await as(a, (r) => r.invoices.get(input.id)))?.buyer).toEqual(BUYER);
});

it("web_rw and worker_rw write the snapshot columns; admin_rw cannot read buyer (42501) but reads the rest", async () => {
  const a = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const id = uuidv7();
  const issued = await as(a, (r) =>
    r.invoices.issue({
      id,
      orderId: order,
      fiscalYear: 2052,
      lines,
      totalMinor: 100n,
      buyer: BUYER,
    }),
  );
  expect(issued.ok).toBe(true);
  const run = (role: "web_rw" | "worker_rw" | "admin_rw", sql: string, params: unknown[] = []) =>
    asRole(t.pool, role, (c) => c.query(sql, params));
  await expect(
    run("admin_rw", "select buyer from invoices where id = $1", [id]),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(run("admin_rw", "select * from invoices where id = $1", [id])).rejects.toMatchObject(
    { code: "42501" },
  );
  const rest = await run(
    "admin_rw",
    `select id, fiscal_year, number, customer_id, order_id, lines, total_minor, issued_at, pdf_key,
            seller, ledger_transaction_id, created_at from invoices where id = $1`,
    [id],
  );
  expect(rest.rowCount).toBe(1);
  // the customer's tax ids stay out of admin_rw as well
  await expect(
    run("admin_rw", "select customer_bin from customers where id = $1", [a]),
  ).rejects.toMatchObject({ code: "42501" });
  // web_rw and worker_rw may insert both snapshots (the grants of 0016 and 0017 together)
  for (const [i, role] of (["web_rw", "worker_rw"] as const).entries()) {
    const b = await newCustomer(t.pool);
    const o = await newOrder(t.pool, b);
    const r = await run(
      role,
      `insert into invoices (id, fiscal_year, number, customer_id, order_id, lines, total_minor, seller, buyer)
       values ($1, 2053, $2, $3, $4, '[{"kind":"service"}]'::jsonb, 100, '{"v":1}'::jsonb, $5::jsonb)`,
      [uuidv7(), i + 1, b, o, JSON.stringify(BUYER)],
    );
    expect(r.rowCount, role).toBe(1);
  }
});
