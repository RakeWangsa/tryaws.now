import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor } from "../repositories/admin/index";
import { parseSellerRowValue } from "../repositories/config/invoice-seller";
import type { CustomerRepos } from "../repositories/customer/index";
import { invoiceBacklogRepo } from "../repositories/system/invoice-backlog";
import { withCustomerRepos } from "../testing/repos";
import { runTransaction } from "../tx";
import {
  TEST_SELLER,
  ensureMarket,
  newAdmin,
  newCustomer,
  newOrder,
  newRenewalCharge as makeRenewalCharge,
  seedSeller,
} from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-I2: the seller on the invoice is the one of the day of issue; a renewal has an invoice of its own
// (reference: its ledger transaction); a charge without seller details is queued, with a notice, and
// issued later in the order of the charge.
const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);

beforeAll(async () => {
  await seedSeller(t.pool);
});

const newRenewalCharge = (customerId: string, amount = 100) =>
  makeRenewalCharge(t.pool, customerId, amount);

const lines = [{ kind: "service", code: "aws", amountMinor: "100" }] as const;

const orderTx = async (orderId: string): Promise<string> =>
  (await t.pool.query("select ledger_transaction_id as id from orders where id = $1", [orderId]))
    .rows[0].id as string;

it("the invoice keeps the seller of the day of issue; a later change does not reach it", async () => {
  const a = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const issued = await as(a, (r) =>
    r.invoices.issue({ id: uuidv7(), orderId: order, fiscalYear: 2050, lines, totalMinor: 100n }),
  );
  expect(issued.ok).toBe(true);
  if (!issued.ok) return;
  expect(parseSellerRowValue(issued.value.seller)?.seller.legalNameEn).toBe("Test Limited");
  expect(issued.value.ledgerTransactionId).toBe(await orderTx(order));
  // The owner changes the legal name and the address.
  await seedSeller(t.pool, "BD", {
    ...TEST_SELLER,
    version: 2,
    legalNameEn: "Renamed Limited",
    addressEn: "Chattogram",
  });
  const again = await as(a, (r) => r.invoices.get(issued.value.id));
  const snapshot = parseSellerRowValue(again?.seller);
  expect(snapshot?.seller.legalNameEn).toBe("Test Limited");
  expect(snapshot?.seller.addressEn).toBe("Dhaka");
  expect(snapshot?.version).toBe(1);
  // A new invoice carries the new seller.
  const next = await as(a, async (r) =>
    r.invoices.issue({
      id: uuidv7(),
      orderId: await newOrder(t.pool, a),
      fiscalYear: 2050,
      lines,
      totalMinor: 100n,
    }),
  );
  expect(next.ok && parseSellerRowValue(next.value.seller)?.seller.legalNameEn).toBe(
    "Renamed Limited",
  );
  await seedSeller(t.pool); // back to the shared test seller
});

it("a renewal gets one invoice for its charge: replay, wrong total and another customer's charge", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const charge = await newRenewalCharge(a, 100);
  const input = (over: object = {}) => ({
    id: uuidv7(),
    ledgerTransactionId: charge,
    fiscalYear: 2051,
    lines,
    totalMinor: 100n,
    ...over,
  });
  // R8: B cannot issue for A's charge; nothing is taken.
  expect(await as(b, (r) => r.invoices.issueForCharge(input()))).toEqual({
    ok: false,
    error: "not_found",
  });
  // R16: the invoice total is the wallet debit of the charge.
  expect(await as(a, (r) => r.invoices.issueForCharge(input({ totalMinor: 99n })))).toEqual({
    ok: false,
    error: "conflict",
  });
  const first = await as(a, (r) => r.invoices.issueForCharge(input()));
  expect(first).toMatchObject({ ok: true, replayed: false, value: { number: 1, orderId: null } });
  const second = await as(a, (r) => r.invoices.issueForCharge(input()));
  expect(second).toMatchObject({ ok: true, replayed: true, value: { number: 1 } });
  expect(
    (
      await t.pool.query(
        "select count(*)::int as n from invoices where ledger_transaction_id = $1",
        [charge],
      )
    ).rows[0].n,
  ).toBe(1);
  // A ledger transaction that is not a renewal (an order's purchase) is no renewal charge.
  const order = await newOrder(t.pool, a);
  const purchaseTx = await orderTx(order);
  expect(
    await as(a, (r) => r.invoices.issueForCharge(input({ ledgerTransactionId: purchaseTx }))),
  ).toEqual({ ok: false, error: "not_found" });
});

it("a renewal invoice is refused without seller details and takes no number", async () => {
  await ensureMarket(t.pool, "RN");
  const a = await newCustomer(t.pool, { market: "RN" });
  const charge = await newRenewalCharge(a);
  const input = {
    id: uuidv7(),
    ledgerTransactionId: charge,
    fiscalYear: 2052,
    lines,
    totalMinor: 100n,
  };
  expect(await as(a, (r) => r.invoices.issueForCharge(input))).toEqual({
    ok: false,
    error: "seller_details_missing",
  });
  await seedSeller(t.pool, "RN");
  expect(await as(a, (r) => r.invoices.issueForCharge(input))).toMatchObject({
    ok: true,
    value: { number: 1 },
  });
});

it("queueBacklog writes the charge and its lines into the admin queue, only for the customer's own charge", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const order = await newOrder(t.pool, a);
  const tx = await orderTx(order);
  const entry = {
    id: uuidv7(),
    kind: "order" as const,
    orderId: order,
    ledgerTransactionId: tx,
    lines,
    totalMinor: 100n,
  };
  // B cannot queue A's charge; neither can A queue another amount.
  expect(await as(b, (r) => r.invoices.queueBacklog(entry))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(a, (r) => r.invoices.queueBacklog({ ...entry, totalMinor: 99n }))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(
    (
      await t.pool.query(
        "select id from discrepancies where details->>'ledgerTransactionId' = $1",
        [tx],
      )
    ).rows,
  ).toEqual([]);
  expect(await as(a, (r) => r.invoices.queueBacklog(entry))).toMatchObject({
    ok: true,
    replayed: false,
  });
  const rows = await t.pool.query(
    "select kind, status, details from discrepancies where details->>'ledgerTransactionId' = $1",
    [tx],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toMatchObject({ kind: "missing", status: "open" });
  expect(rows.rows[0].details).toEqual({
    source: "invoice_seller_missing",
    v: 1,
    charge: "order",
    customerId: a,
    orderId: order,
    ledgerTransactionId: tx,
    totalMinor: "100",
    lines,
  });
  // The shape is checked: an order entry needs an order, a renewal entry must not have one.
  expect(
    await as(a, (r) => r.invoices.queueBacklog({ ...entry, id: uuidv7(), kind: "renewal" })),
  ).toEqual({ ok: false, error: "validation" });
});

it("the pending charges come oldest first and leave the list once their invoice exists", async () => {
  await ensureMarket(t.pool, "PQ");
  const a = await newCustomer(t.pool, { market: "PQ" });
  const o1 = await newOrder(t.pool, a);
  const renewal = await newRenewalCharge(a);
  const o2 = await newOrder(t.pool, a);
  const queue = async (e: Parameters<CustomerRepos["invoices"]["queueBacklog"]>[0]) =>
    as(a, (r) => r.invoices.queueBacklog(e));
  await queue({
    id: uuidv7(),
    kind: "order",
    orderId: o1,
    ledgerTransactionId: await orderTx(o1),
    lines,
    totalMinor: 100n,
  });
  await queue({
    id: uuidv7(),
    kind: "renewal",
    ledgerTransactionId: renewal,
    lines,
    totalMinor: 100n,
  });
  await queue({
    id: uuidv7(),
    kind: "order",
    orderId: o2,
    ledgerTransactionId: await orderTx(o2),
    lines,
    totalMinor: 100n,
  });
  const pending = () =>
    runTransaction(t.db, (tx) => invoiceBacklogRepo(tx).pending(50), { role: "worker_rw" });
  const mine = async () => (await pending()).items.filter((p) => p.customerId === a);
  expect((await mine()).map((p) => p.kind)).toEqual(["order", "renewal", "order"]);
  expect((await mine())[0]).toMatchObject({ totalMinor: 100n, orderId: o1 });
  expect((await pending()).unreadable).toBe(0);

  const admin: AdminActor = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "t",
  };
  const count = () =>
    runTransaction(t.db, (tx) => adminRepos(tx, admin).invoiceSeller.backlog("PQ"), {
      role: "admin_rw",
    });
  expect(await count()).toMatchObject({ ok: true, value: { count: 3 } });

  // No seller yet in PQ: every issue is refused. After the owner enters it, the oldest goes first and
  // the numbers follow the order of the charge.
  await seedSeller(t.pool, "PQ");
  const rows = await mine();
  const numbers: number[] = [];
  for (const row of rows) {
    const w = await as(a, (r) =>
      row.kind === "order"
        ? r.invoices.issue({
            id: uuidv7(),
            orderId: row.orderId!,
            fiscalYear: 2053,
            lines,
            totalMinor: row.totalMinor,
          })
        : r.invoices.issueForCharge({
            id: uuidv7(),
            ledgerTransactionId: row.ledgerTransactionId,
            fiscalYear: 2053,
            lines,
            totalMinor: row.totalMinor,
          }),
    );
    expect(w.ok).toBe(true);
    if (w.ok) numbers.push(w.value.number);
  }
  expect(numbers).toEqual([1, 2, 3]);
  expect(await mine()).toEqual([]);
  expect(await count()).toMatchObject({ ok: true, value: { count: 0, oldest: null } });
});

it("the backlog count is for finance and superadmin only", async () => {
  const ops: AdminActor = {
    adminId: await newAdmin(t.pool, "ops"),
    role: "ops",
    ip: "203.0.113.9",
    userAgent: "t",
  };
  expect(
    await runTransaction(t.db, (tx) => adminRepos(tx, ops).invoiceSeller.backlog("BD"), {
      role: "admin_rw",
    }),
  ).toEqual({ ok: false, error: "forbidden" });
});
