import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newOrder, seedSeller } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-I3: the customer billing profile (migration 0017). The repository writes only the session
// customer's four columns; the values are personal or business identifiers.

const t = useTempDatabase();
beforeAll(async () => {
  await seedSeller(t.pool);
});
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);

const EMPTY = { billingName: null, billingAddress: null, customerBin: null, customerNid: null };
const FULL = {
  billingName: "Rahim & Sons Ltd.",
  billingAddress: "House 5, Road 3, Dhanmondi, Dhaka",
  customerBin: "1234567890123",
  customerNid: null,
};

it("a new customer has an empty billing profile", async () => {
  const id = await newCustomer(t.pool);
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(EMPTY);
});

it("setBilling stores the four fields for the session customer and getBilling reads them back", async () => {
  const id = await newCustomer(t.pool);
  const w = await as(id, (r) => r.profile.setBilling(FULL));
  expect(w).toMatchObject({ ok: true, value: FULL });
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(FULL);
});

it("is idempotent by absolute assignment, and an empty profile clears the fields", async () => {
  const id = await newCustomer(t.pool);
  await as(id, (r) => r.profile.setBilling(FULL));
  await as(id, (r) => r.profile.setBilling(FULL));
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(FULL);
  await as(id, (r) => r.profile.setBilling(EMPTY));
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(EMPTY);
});

it("one customer's write never touches another customer's row (R8)", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  await as(a, (r) => r.profile.setBilling(FULL));
  expect(await as(b, (r) => r.profile.getBilling())).toEqual(EMPTY);
  const { rows } = await t.pool.query(
    "select id from customers where customer_bin is not null and id in ($1, $2)",
    [a, b],
  );
  expect(rows).toEqual([{ id: a }]);
});

it("the repository refuses what the CHECKs would refuse, before any query", async () => {
  const id = await newCustomer(t.pool);
  for (const bad of [
    { ...EMPTY, customerBin: "123" },
    { ...EMPTY, customerNid: "12345" },
    { ...EMPTY, customerBin: "1234567890123", customerNid: "1234567890" },
    { ...EMPTY, billingAddress: "x".repeat(301) },
    { ...EMPTY, billingAddress: "Road\u0000 5, Dhaka" },
    { ...EMPTY, billingName: "x" },
    { ...EMPTY, billingName: "<b>x</b>" },
  ]) {
    expect(await as(id, (r) => r.profile.setBilling(bad))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(EMPTY);
});

it("the database refuses the same values even if the repository is bypassed (CHECK)", async () => {
  const id = await newCustomer(t.pool);
  for (const [column, value] of [
    ["customer_bin", "123"],
    ["customer_nid", "12345"],
    ["billing_address", "bad\u0007address"],
    ["billing_name", "x"],
  ] as const) {
    await expect(
      t.pool.query(`update customers set ${column} = $1 where id = $2`, [value, id]),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(
    t.pool.query(
      "update customers set customer_bin = '1234567890123', customer_nid = '1234567890' where id = $1",
      [id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("profile.get and update do not carry the billing fields (the profile screen has none)", async () => {
  const id = await newCustomer(t.pool);
  await as(id, (r) => r.profile.setBilling(FULL));
  const p = await as(id, (r) => r.profile.get());
  expect(Object.keys(p ?? {})).not.toContain("customerBin");
  expect(Object.keys(p ?? {})).not.toContain("billingAddress");
  // a name change leaves the billing profile alone
  await as(id, (r) => r.profile.update({ name: "Karim" }));
  expect(await as(id, (r) => r.profile.getBilling())).toEqual(FULL);
});

it("roles: web_rw updates the four columns only; admin_rw cannot read them; worker_rw reads only them", async () => {
  const id = await newCustomer(t.pool);
  await as(id, (r) => r.profile.setBilling(FULL));
  const asRole = async (role: string, sql: string) => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      return await c.query(sql);
    } finally {
      await c.query("rollback");
      c.release();
    }
  };
  await expect(asRole("admin_rw", `select customer_bin from customers`)).rejects.toMatchObject({
    code: "42501",
  });
  await expect(asRole("admin_rw", `select billing_address from customers`)).rejects.toMatchObject({
    code: "42501",
  });
  await expect(
    asRole("admin_rw", `select id, email, name, kyc_status from customers`),
  ).resolves.toBeDefined();
  await expect(asRole("worker_rw", `select customer_nid from customers`)).resolves.toBeDefined();
  await expect(asRole("web_rw", `update customers set customer_nid = null`)).resolves.toBeDefined();
  await expect(
    asRole(
      "web_rw",
      `insert into customers (id, cognito_sub, email, market, customer_bin) values (gen_random_uuid(), 'x', 'x@y.z', 'BD', '1234567890123')`,
    ),
  ).rejects.toMatchObject({ code: "42501" });
});

// ---- the buyer snapshot of the invoice -------------------------------------------------------------

const lines = [{ kind: "service", code: "aws", amountMinor: "100" }] as const;
// Each test takes its own fiscal year, so its invoice is number 1 of that year.
let year = 2040;
const invoiceInput = (orderId: string, fiscalYear = year) => ({
  id: uuidv7(),
  orderId,
  fiscalYear,
  lines,
  totalMinor: 100n,
});
const BUYER = {
  name: "Rahim & Sons Ltd.",
  address: "House 5, Road 3, Dhanmondi, Dhaka",
  taxId: { kind: "bin", value: "1234567890123" },
} as const;

it("issue stores the buyer snapshot passed by the caller, and the invoice reads it back", async () => {
  const id = await newCustomer(t.pool);
  const order = await newOrder(t.pool, id);
  const w = await as(id, (r) => r.invoices.issue({ ...invoiceInput(order), buyer: BUYER }));
  if (!w.ok) throw new Error("issue refused");
  expect(w.value.buyer).toEqual(BUYER);
  const again = await as(id, (r) => r.invoices.get(w.value.id));
  expect(again?.buyer).toEqual(BUYER);
});

it("without a buyer the invoice has none: the invoice prints '-' as before", async () => {
  const id = await newCustomer(t.pool);
  const order = await newOrder(t.pool, id);
  const w = await as(id, (r) => r.invoices.issue(invoiceInput(order)));
  if (!w.ok) throw new Error("issue refused");
  expect(w.value.buyer).toBeNull();
});

it("the snapshot is a copy: a later change of the profile does not change the issued invoice", async () => {
  const id = await newCustomer(t.pool);
  const order = await newOrder(t.pool, id);
  const w = await as(id, (r) => r.invoices.issue({ ...invoiceInput(order), buyer: BUYER }));
  if (!w.ok) throw new Error("issue refused");
  await as(id, (r) => r.profile.setBilling({ ...EMPTY, billingAddress: "Somewhere else, Sylhet" }));
  expect((await as(id, (r) => r.invoices.get(w.value.id)))?.buyer).toEqual(BUYER);
});

it("a malformed buyer is refused before a number is taken", async () => {
  year += 1;
  const id = await newCustomer(t.pool);
  const order = await newOrder(t.pool, id);
  for (const buyer of [
    "x",
    [],
    { name: 5, address: null, taxId: null },
    { name: null, address: null, taxId: { kind: "bin", value: "12" } },
    { name: null, address: "x".repeat(301), taxId: null },
  ]) {
    const w = await as(id, (r) =>
      r.invoices.issue({ ...invoiceInput(order), buyer: buyer as never }),
    );
    expect(w).toEqual({ ok: false, error: "validation" });
  }
  expect(
    await as(id, (r) => r.invoices.issue({ ...invoiceInput(order), buyer: BUYER })),
  ).toMatchObject({ ok: true, value: { number: 1 } });
});
