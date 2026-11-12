// WPU-I2: every paid purchase and renewal gets exactly one tax invoice (spec 9.3), issued in the
// transaction of the charge. A missing seller never stops a payment or a renewal: the invoice is queued
// with its lines and the scheduler job issues it later, oldest first. Run as web_rw (the panel) and
// worker_rw (the scheduler), so a missing grant shows here.
import { parseSellerRowValue } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, PLAN_TOTAL, START, type Kit } from "../test/orders-kit";
import { renewNow } from "../lifecycle/renew-now";
import { runInvoiceBacklog } from "./backlog";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWorker = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });
const logs: Record<string, unknown>[] = [];
const sweep = (pageSize?: number) =>
  runInvoiceBacklog({
    runTx: asWorker,
    clock: kit.clock,
    log: (e) => logs.push(e),
    ...(pageSize === undefined ? {} : { pageSize }),
  });

const SELLER = {
  v: 1,
  version: 1,
  legalNameBn: "পরীক্ষা লিমিটেড",
  legalNameEn: "Test Limited",
  bin: "0000000000000",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "Test Signatory",
  signatoryDesignation: "Director",
};
const setSeller = async (value: unknown): Promise<void> => {
  await t.pool.query("delete from settings where key = 'invoice_seller' and market = 'BD'");
  if (value === null) return;
  await t.pool.query(
    `insert into settings (id, key, market, scope, value)
     values (gen_random_uuid(), 'invoice_seller', 'BD', 'market', $1::jsonb)`,
    [JSON.stringify(value)],
  );
};
const invoicesOf = async (customerId: string) =>
  q(
    `select number, fiscal_year, total_minor::text as total, lines, seller, order_id, ledger_transaction_id
       from invoices where customer_id = $1 order by number`,
    [customerId],
  );
const owed = async (customerId: string) =>
  q(
    `select details from discrepancies
      where details->>'source' = 'invoice_seller_missing' and details->>'customerId' = $1
      order by created_at, id`,
    [customerId],
  );

beforeAll(async () => {
  kit = await makeKit(t);
});

describe("the invoice of a purchase", () => {
  it("is issued once, in the transaction of the purchase, with the seller of the day and the VAT rate", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const { orderId } = await placeOne(kit, buyer);
    const [invoice] = await invoicesOf(buyer.customerId);
    expect(invoice).toMatchObject({
      order_id: orderId,
      total: String(PLAN_TOTAL),
      fiscal_year: 2026,
    });
    const order = (
      await q("select ledger_transaction_id from orders where id = $1", [orderId])
    )[0]!;
    expect(invoice?.ledger_transaction_id).toBe(order.ledger_transaction_id);
    // The lines are those of the charge: the AWS price and one line for each step, the rate with it.
    const lines = invoice?.lines as { code: string; amountMinor: string; rate?: string }[];
    expect(lines.map((l) => [l.code, l.amountMinor, l.rate])).toEqual([
      ["aws", "63500", undefined],
      ["korea_vat", "6350", "0.10"],
      ["bd_vat", "3175", "0.05"],
      ["processing_fee", "1270", "0.02"],
    ]);
    expect(parseSellerRowValue(invoice?.seller)?.seller.legalNameEn).toBe("Test Limited");
    expect(await owed(buyer.customerId)).toEqual([]);
  });

  it("a seller change after the issue does not reach the stored invoice", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    await placeOne(kit, buyer);
    await setSeller({
      ...SELLER,
      version: 2,
      legalNameEn: "Renamed Limited",
      addressEn: "Rajshahi",
    });
    const [invoice] = await invoicesOf(buyer.customerId);
    expect(parseSellerRowValue(invoice?.seller)?.seller).toMatchObject({
      legalNameEn: "Test Limited",
      addressEn: "Dhaka",
    });
  });

  it("without seller details the purchase still goes through: no invoice, one queue entry, then the job issues it", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const before = await kit.balance(buyer.customerId);
    const { orderId } = await placeOne(kit, buyer);
    expect(await kit.balance(buyer.customerId)).toBe(before - PLAN_TOTAL);
    expect((await q("select status from orders where id = $1", [orderId]))[0]!.status).toBe("paid");
    expect(await invoicesOf(buyer.customerId)).toEqual([]);
    const queue = await owed(buyer.customerId);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.details).toMatchObject({
      charge: "order",
      orderId,
      totalMinor: String(PLAN_TOTAL),
    });

    // Still no seller: the job issues nothing and says why.
    const stuck = await sweep();
    expect(stuck).toMatchObject({ issued: 0, sellerMissing: true });
    expect(await invoicesOf(buyer.customerId)).toEqual([]);

    // The owner enters the seller: the job issues the invoice, and a second run changes nothing.
    await setSeller(SELLER);
    expect(await sweep()).toMatchObject({ sellerMissing: false, failed: 0 });
    const [invoice] = await invoicesOf(buyer.customerId);
    expect(invoice).toMatchObject({ order_id: orderId, total: String(PLAN_TOTAL) });
    expect(parseSellerRowValue(invoice?.seller)?.seller.legalNameEn).toBe("Test Limited");
    const again = await sweep();
    expect(again.issued).toBe(0);
    expect(await invoicesOf(buyer.customerId)).toHaveLength(1);
  });

  it("a backlog is issued in the order of the charge, with sequential numbers", async () => {
    await setSeller(null);
    // Drain what earlier tests left owed, so the numbers of this test are the next ones.
    kit.clock.set(START);
    const first = await kit.newBuyer();
    const second = await kit.newBuyer();
    await placeOne(kit, first);
    kit.clock.advance(60);
    await placeOne(kit, second);
    kit.clock.advance(60);
    await placeOne(kit, first);
    await setSeller(SELLER);
    // A page of one issues the oldest only.
    const taken = (
      await q("select coalesce(max(number), 0)::int as n from invoices where fiscal_year = 2026")
    )[0]!.n as number;
    const queued = [...(await owed(first.customerId)), ...(await owed(second.customerId))];
    expect(queued.length).toBe(3);
    await sweep(); // everything owed, oldest first
    const numbers = async (customerId: string) =>
      (await invoicesOf(customerId)).map((i) => Number(i.number));
    const one = await numbers(first.customerId);
    const two = await numbers(second.customerId);
    expect([...one, ...two].sort((a, b) => a - b)).toEqual([taken + 1, taken + 2, taken + 3]);
    // Charge order: first's first purchase, second's purchase, first's second purchase.
    expect(one[0]).toBe(taken + 1);
    expect(two[0]).toBe(taken + 2);
    expect(one[1]).toBe(taken + 3);
  });
});

describe("an invoice that cannot be written never fails the charge", () => {
  it("a failing invoice insert is rolled back to its savepoint; the purchase stands and the invoice is owed", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const before = await kit.balance(buyer.customerId);
    await t.pool
      .query(`create or replace function public.wpu_i2_fail() returns trigger language plpgsql as
      $$ begin raise exception 'wpu_i2_test'; end $$`);
    await t.pool.query(
      "create trigger wpu_i2_fail before insert on invoices for each row execute function public.wpu_i2_fail()",
    );
    try {
      const { orderId } = await placeOne(kit, buyer);
      expect(await kit.balance(buyer.customerId)).toBe(before - PLAN_TOTAL);
      expect((await q("select status from orders where id = $1", [orderId]))[0]!.status).toBe(
        "paid",
      );
      expect(await invoicesOf(buyer.customerId)).toEqual([]);
      expect(await owed(buyer.customerId)).toHaveLength(1);
    } finally {
      await t.pool.query("drop trigger wpu_i2_fail on invoices");
      await t.pool.query("drop function public.wpu_i2_fail()");
    }
    await sweep();
    expect(await invoicesOf(buyer.customerId)).toHaveLength(1);
  });
});

describe("the invoice of a renewal", () => {
  async function dueRenewal(): Promise<{
    customerId: string;
    resourceId: string;
    subscriptionId: string;
  }> {
    kit.clock.set(START);
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const s = (
      await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
    )[0]!;
    await q("update resources set state = 'active' where id = $1", [resourceId]);
    await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
    kit.clock.set(new Date((s.period_end as Date).getTime() - 2 * DAY));
    return { customerId: buyer.customerId, resourceId, subscriptionId: String(s.id) };
  }
  const renew = (f: { customerId: string; resourceId: string }) =>
    runTransaction(t.db, (tx) => renewNow(tx, { ...f, clock: kit.clock }), { role: "web_rw" });

  it("is issued with the renewal, once, and a second click makes no second invoice", async () => {
    await setSeller(SELLER);
    const f = await dueRenewal();
    expect((await renew(f)).ok).toBe(true);
    expect((await renew(f)).ok).toBe(false);
    const all = await invoicesOf(f.customerId);
    expect(all).toHaveLength(2); // the purchase and the renewal
    const renewal = all.find((i) => i.order_id === null)!;
    const ledger = (
      await q("select id from ledger_transactions where kind = 'renewal' and reference_id = $1", [
        f.subscriptionId,
      ])
    )[0]!;
    expect(renewal.ledger_transaction_id).toBe(ledger.id);
    const lines = renewal.lines as { code: string; rate?: string }[];
    expect(lines.find((l) => l.code === "bd_vat")?.rate).toBe("0.05");
    expect(parseSellerRowValue(renewal.seller)?.seller.legalNameEn).toBe("Test Limited");
  });

  it("without seller details the renewal is charged and the period moves; the job issues the invoice later", async () => {
    await setSeller(SELLER);
    const f = await dueRenewal();
    await setSeller(null);
    const before = await kit.balance(f.customerId);
    expect((await renew(f)).ok).toBe(true);
    expect(await kit.balance(f.customerId)).toBeLessThan(before);
    expect((await invoicesOf(f.customerId)).filter((i) => i.order_id === null)).toEqual([]);
    const queue = await owed(f.customerId);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.details).toMatchObject({ charge: "renewal" });

    await setSeller(SELLER);
    await sweep();
    const renewal = (await invoicesOf(f.customerId)).filter((i) => i.order_id === null);
    expect(renewal).toHaveLength(1);
    await sweep();
    expect((await invoicesOf(f.customerId)).filter((i) => i.order_id === null)).toHaveLength(1);
  });
});

// WPU-I4: the invoice carries the seller AND the buyer of the day of issue (migrations 0016 and 0017).
describe("the buyer on the invoice", () => {
  const BILLING = {
    name: "Rahim Traders Ltd",
    address: "House 5, Road 3, Dhanmondi, Dhaka",
    bin: "1234567890123",
  };
  const setBilling = (customerId: string, name: string, address: string) =>
    q(
      "update customers set billing_name = $2, billing_address = $3, customer_bin = $4 where id = $1",
      [customerId, name, address, BILLING.bin],
    );
  const buyersOf = (customerId: string) =>
    q("select buyer, seller from invoices where customer_id = $1 order by number", [customerId]);

  it("an invoice issued after the customer entered billing details carries both snapshots", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    await setBilling(buyer.customerId, BILLING.name, BILLING.address);
    await placeOne(kit, buyer);
    const [row] = await buyersOf(buyer.customerId);
    expect(row?.buyer).toEqual({
      name: BILLING.name,
      address: BILLING.address,
      taxId: { kind: "bin", value: BILLING.bin },
    });
    expect(parseSellerRowValue(row?.seller)?.seller.legalNameEn).toBe("Test Limited");
  });

  it("a profile change after the issue does not change the stored buyer (a reprint)", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    await setBilling(buyer.customerId, BILLING.name, BILLING.address);
    await placeOne(kit, buyer);
    await setBilling(buyer.customerId, "Someone Else", "Another Road, Rajshahi");
    const [row] = await buyersOf(buyer.customerId);
    expect(row?.buyer).toMatchObject({ name: BILLING.name, address: BILLING.address });
  });

  it("a purchase with no billing details stores no buyer (the invoice prints '-')", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    await placeOne(kit, buyer);
    const [row] = await buyersOf(buyer.customerId);
    expect(row?.buyer).toBeNull();
  });

  it("a renewal carries the buyer of the day of the renewal", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const s = (
      await q("select period_end from subscriptions where resource_id = $1", [resourceId])
    )[0]!;
    await q("update resources set state = 'active' where id = $1", [resourceId]);
    await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
    kit.clock.set(new Date((s.period_end as Date).getTime() - 2 * DAY));
    await setBilling(buyer.customerId, BILLING.name, BILLING.address);
    const done = await runTransaction(
      t.db,
      (tx) => renewNow(tx, { customerId: buyer.customerId, resourceId, clock: kit.clock }),
      { role: "web_rw" },
    );
    expect(done.ok).toBe(true);
    const rows = await q("select buyer from invoices where customer_id = $1 and order_id is null", [
      buyer.customerId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.buyer).toMatchObject({ name: BILLING.name, address: BILLING.address });
  });

  it("a backlog invoice carries the buyer current at ISSUE, read by the worker", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    await setBilling(buyer.customerId, "Name At Charge", "Road At Charge, Dhaka");
    await placeOne(kit, buyer);
    expect(await buyersOf(buyer.customerId)).toEqual([]);
    // The customer changes the details while the invoice waits; the owner then enters the seller.
    await setBilling(buyer.customerId, BILLING.name, BILLING.address);
    await setSeller(SELLER);
    expect(await sweep()).toMatchObject({ failed: 0 });
    const [row] = await buyersOf(buyer.customerId);
    expect(row?.buyer).toMatchObject({ name: BILLING.name, address: BILLING.address });
  });
});
