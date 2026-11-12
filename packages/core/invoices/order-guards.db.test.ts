// WPU-I5: the invoice queue keeps the order of the charges, never invoices reversed money, never loses a
// charge, and the fiscal year and the printed date come from one instant. Run as web_rw (the panel) and
// worker_rw (the scheduler).
import type { Tx } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { reverseTransaction } from "../ledger/reverse";
import type { PriceSnapshot } from "../pricing/snapshot";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { runInvoiceBacklog } from "./backlog";
import { issueChargeInvoice } from "./charge";

const t = useTempDatabase();
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWorker = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });
const asWeb = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "web_rw" });
const logs: Record<string, unknown>[] = [];
const sweep = () =>
  runInvoiceBacklog({ runTx: asWorker, clock: kit.clock, log: (e) => logs.push({ ...e }) });

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
const invoiceOf = async (orderId: string) =>
  (
    await q("select number, fiscal_year, issued_at from invoices where order_id = $1", [orderId])
  )[0];
const ledgerOf = async (orderId: string): Promise<string> =>
  String(
    (await q("select ledger_transaction_id as id from orders where id = $1", [orderId]))[0]!.id,
  );
const queueRow = async (ledgerTransactionId: string) =>
  (
    await q(
      "select id, status, details from discrepancies where details->>'source' = 'invoice_seller_missing' and details->>'ledgerTransactionId' = $1",
      [ledgerTransactionId],
    )
  )[0];
const reverse = (transactionId: string) =>
  asWorker((tx) => reverseTransaction(tx, { transactionId, actor: { type: "system" } }));

beforeAll(async () => {
  kit = await makeKit(t);
  await setSeller(SELLER);
  kit.clock.set(START);
});

describe("the order of the numbers", () => {
  it("a new charge is queued, not issued, while an older charge waits; the job issues them in order", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const older = await placeOne(kit, await kit.newBuyer());
    expect(await invoiceOf(older.orderId)).toBeUndefined();
    // The seller is entered, but the older charge is still owed: the live path must not overtake it.
    await setSeller(SELLER);
    const newer = await placeOne(kit, await kit.newBuyer());
    expect(await invoiceOf(newer.orderId)).toBeUndefined();
    expect(await queueRow(await ledgerOf(newer.orderId))).toBeDefined();
    const report = await sweep();
    expect(report.failed).toBe(0);
    const a = await invoiceOf(older.orderId);
    const b = await invoiceOf(newer.orderId);
    expect(Number(b!.number)).toBe(Number(a!.number) + 1);
    // The queue is empty now: the next charge is issued live again.
    const live = await placeOne(kit, await kit.newBuyer());
    expect(await invoiceOf(live.orderId)).toBeDefined();
  });

  it("the job stops at the first refusal for another reason: later charges never overtake it", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const first = await placeOne(kit, await kit.newBuyer());
    const second = await placeOne(kit, await kit.newBuyer());
    const third = await placeOne(kit, await kit.newBuyer());
    await setSeller(SELLER);
    const secondTx = await ledgerOf(second.orderId);
    // The second entry is damaged in a way the issue refuses (its total is not the order's).
    await t.pool.query(
      `update discrepancies set details = jsonb_set(details, '{totalMinor}', '"1"')
        where details->>'source' = 'invoice_seller_missing' and details->>'ledgerTransactionId' = $1`,
      [secondTx],
    );
    const stopped = await sweep();
    expect(stopped).toMatchObject({ issued: 1, failed: 1, blocked: true });
    expect(await invoiceOf(first.orderId)).toBeDefined();
    expect(await invoiceOf(second.orderId)).toBeUndefined();
    expect(await invoiceOf(third.orderId)).toBeUndefined();
    // A marker with the reason is the notice for a person; ids and a fixed code only (R14).
    const marker = (
      await q(
        "select status, details from discrepancies where details->>'source' = 'invoice_backlog_mark' and details->>'state' = 'failed' and details->>'ledgerTransactionId' = $1",
        [secondTx],
      )
    )[0];
    expect(marker).toMatchObject({ status: "open" });
    expect(marker?.details).toMatchObject({ reason: "refused:conflict" });
    // Fixed: the next run tries the same entry first and then goes on, in order.
    await t.pool.query(
      `update discrepancies set details = jsonb_set(details, '{totalMinor}', $2::jsonb)
        where details->>'source' = 'invoice_seller_missing' and details->>'ledgerTransactionId' = $1`,
      [
        secondTx,
        JSON.stringify(
          String(
            (
              await q("select total_minor::text as n from orders where id = $1", [second.orderId])
            )[0]!.n,
          ),
        ),
      ],
    );
    const resumed = await sweep();
    expect(resumed).toMatchObject({ issued: 2, failed: 0, blocked: false });
    const numbers = [first, second, third].map(async (o) =>
      Number((await invoiceOf(o.orderId))!.number),
    );
    const [n1, n2, n3] = await Promise.all(numbers);
    expect([n2, n3]).toEqual([n1! + 1, n1! + 2]);
  });
});

describe("a reversed charge", () => {
  it("is never invoiced: the queue row is closed with the reason, and later charges go on", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const gone = await placeOne(kit, await kit.newBuyer());
    const kept = await placeOne(kit, await kit.newBuyer());
    const goneTx = await ledgerOf(gone.orderId);
    expect((await reverse(goneTx)).ok).toBe(true);
    await setSeller(SELLER);
    const report = await sweep();
    expect(report).toMatchObject({ reversed: 1, failed: 0 });
    expect(await invoiceOf(gone.orderId)).toBeUndefined();
    expect(await invoiceOf(kept.orderId)).toBeDefined();
    expect((await queueRow(goneTx))?.status).toBe("resolved");
    const marker = (
      await q(
        "select status, details from discrepancies where details->>'source' = 'invoice_backlog_mark' and details->>'ledgerTransactionId' = $1",
        [goneTx],
      )
    )[0];
    expect(marker).toMatchObject({ status: "resolved" });
    expect(marker?.details).toMatchObject({ state: "resolved", reason: "charge_reversed" });
    // The live path refuses to invoice it either (issueChargeInvoice on a reversed charge).
    const again = await sweep();
    expect(again).toMatchObject({ reversed: 0, issued: 0 });
  });

  it("an invoice already issued stays as it is; a credit-note notice is written once", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const bought = await placeOne(kit, await kit.newBuyer());
    const tx = await ledgerOf(bought.orderId);
    const before = await invoiceOf(bought.orderId);
    expect(before).toBeDefined();
    expect((await reverse(tx)).ok).toBe(true);
    expect((await reverse(tx)).ok).toBe(true); // a replay
    expect(await invoiceOf(bought.orderId)).toEqual(before);
    const notices = await q(
      "select kind, status, details from discrepancies where details->>'source' = 'credit_note_needed' and details->>'ledgerTransactionId' = $1",
      [tx],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "missing", status: "open" });
    // The reconciliation finds a reversed charge whose notice is missing and writes it.
    await t.pool.query(
      "delete from discrepancies where details->>'source' = 'credit_note_needed' and details->>'ledgerTransactionId' = $1",
      [tx],
    );
    expect(await sweep()).toMatchObject({ creditNotes: 1 });
    expect(
      await q(
        "select 1 from discrepancies where details->>'source' = 'credit_note_needed' and details->>'ledgerTransactionId' = $1",
        [tx],
      ),
    ).toHaveLength(1);
  });
});

describe("a corrupt queue row", () => {
  it("is marked unreadable and skipped; valid entries are issued", async () => {
    await setSeller(null);
    kit.clock.set(START);
    await t.pool.query(
      `insert into discrepancies (id, kind, details) values (gen_random_uuid(), 'missing', '{"source":"invoice_seller_missing","v":1,"customerId":"x"}'::jsonb)`,
    );
    const ok = await placeOne(kit, await kit.newBuyer());
    await setSeller(SELLER);
    const report = await sweep();
    expect(report.unreadable).toBeGreaterThanOrEqual(1);
    expect(await invoiceOf(ok.orderId)).toBeDefined();
    const marked = await q(
      "select status from discrepancies where details->>'source' = 'invoice_backlog_mark' and details->>'reason' = 'unreadable'",
    );
    expect(marked.length).toBeGreaterThanOrEqual(1);
    expect(marked.every((m) => m.status === "open")).toBe(true);
    // Next run: nothing left unreadable.
    expect((await sweep()).unreadable).toBe(0);
  });
});

describe("the fiscal year and the date of issue come from one instant", () => {
  it("2027-06-30T17:59:59.9Z is fiscal year 2026, 18:00:00.0Z is 2027, and issued_at is that instant", async () => {
    const issueAt = async (iso: string) => {
      await setSeller(null);
      kit.clock.set(START);
      const placed = await placeOne(kit, await kit.newBuyer());
      await setSeller(SELLER);
      kit.clock.set(new Date(iso));
      expect(await sweep()).toMatchObject({ failed: 0 });
      return (await invoiceOf(placed.orderId))!;
    };
    const before = await issueAt("2027-06-30T17:59:59.900Z");
    expect(Number(before.fiscal_year)).toBe(2026);
    expect((before.issued_at as Date).toISOString()).toBe("2027-06-30T17:59:59.900Z");
    const after = await issueAt("2027-06-30T18:00:00.000Z");
    expect(Number(after.fiscal_year)).toBe(2027);
    expect((after.issued_at as Date).toISOString()).toBe("2027-06-30T18:00:00.000Z");
    kit.clock.set(START);
  });
});

describe("a charge never ends with no invoice and no record", () => {
  const snapshotOf = async (orderId: string): Promise<PriceSnapshot> =>
    (await q("select price_snapshot as s from orders where id = $1", [orderId]))[0]!
      .s as PriceSnapshot;

  it("lines that cannot be built: a notice with ids is written and the outcome says so", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const placed = await placeOne(kit, buyer);
    const tx = await ledgerOf(placed.orderId);
    await t.pool.query("delete from invoices where order_id = $1", [placed.orderId]);
    const snapshot = await snapshotOf(placed.orderId);
    const events: Record<string, unknown>[] = [];
    const outcome = await asWeb((db: Tx) =>
      issueChargeInvoice(db, {
        customerId: buyer.customerId,
        charge: { kind: "order", orderId: placed.orderId },
        ledgerTransactionId: tx,
        snapshot: { ...snapshot, steps: [{ code: "mystery", amountMinor: "1" }] },
        now: kit.clock.now(),
        log: (e) => events.push({ ...e }),
      }),
    );
    expect(outcome).toBe("noted");
    const note = (
      await q(
        "select details from discrepancies where details->>'source' = 'invoice_charge_unrecorded' and details->>'ledgerTransactionId' = $1",
        [tx],
      )
    )[0];
    expect(note?.details).toMatchObject({ charge: "order", customerId: buyer.customerId });
    expect(events).toEqual([
      {
        event: "invoice_charge_unrecorded",
        outcome: "noted",
        charge: "order",
        ledgerTransactionId: tx,
      },
    ]);
  });

  it("nothing can be written: a structured error log with ids only, and a distinguishable outcome", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const other = await kit.newBuyer();
    const placed = await placeOne(kit, buyer);
    const tx = await ledgerOf(placed.orderId);
    await t.pool.query("delete from invoices where order_id = $1", [placed.orderId]);
    const events: Record<string, unknown>[] = [];
    // another customer's id: the notice is refused (R8), and so is the queue row.
    const outcome = await asWeb((db: Tx) =>
      issueChargeInvoice(db, {
        customerId: other.customerId,
        charge: { kind: "renewal" },
        ledgerTransactionId: tx,
        snapshot: { ...(JSON.parse(JSON.stringify(placed)) as object), totalMinor: "1" } as never,
        now: kit.clock.now(),
        log: (e) => events.push({ ...e }),
      }),
    );
    expect(outcome).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "invoice_charge_unrecorded", outcome: "failed" });
    expect(JSON.stringify(events)).not.toMatch(/@|\+880|name/i);
  });

  it("the reconciliation queues an order with no invoice and no queue row, and notes a renewal", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    // what the tests above left unrecorded on purpose is reconciled first
    await sweep();
    const lost = await placeOne(kit, await kit.newBuyer());
    const lostTx = await ledgerOf(lost.orderId);
    await t.pool.query("delete from invoices where order_id = $1", [lost.orderId]);
    const report = await sweep();
    expect(report).toMatchObject({ reconciled: 1, failed: 0 });
    // queued with its lines, then issued by the same run
    expect(await invoiceOf(lost.orderId)).toBeDefined();
    expect((await queueRow(lostTx))?.details).toMatchObject({
      charge: "order",
      orderId: lost.orderId,
    });
    // a second run finds nothing to reconcile
    expect(await sweep()).toMatchObject({ reconciled: 0, noted: 0 });
  });
});
