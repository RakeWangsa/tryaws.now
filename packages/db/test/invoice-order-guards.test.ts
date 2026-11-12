import { v7 as uuidv7 } from "uuid";
import { beforeAll, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { invoiceBacklogRepo } from "../repositories/system/invoice-backlog";
import { withCustomerRepos } from "../testing/repos";
import { runTransaction } from "../tx";
import {
  ensureMarket,
  newCustomer,
  newOrder,
  newRenewalCharge,
  seedSeller,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";
import { inTransaction, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-I5: what the invoice queue does with a reversed charge, the one instant of the fiscal year and the
// date, the buyer limit, the order of the numbers, and the notice for an invoice that needs a credit note.
const t = useTempDatabase();
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);
const worker = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });
const lines = [{ kind: "service", code: "aws", amountMinor: "100" }] as const;
const astral = "\u{1F600}";

const orderTx = async (orderId: string): Promise<string> =>
  (await t.pool.query("select ledger_transaction_id as id from orders where id = $1", [orderId]))
    .rows[0].id as string;
// The reversal of a ledger transaction, as reverseTransaction posts it (kind reversal, the lines turned).
const reverse = async (original: string): Promise<void> => {
  const rows = (
    await t.pool.query(
      "select account_id, direction, amount_minor::int as amount from ledger_entries where transaction_id = $1",
      [original],
    )
  ).rows as { account_id: string; direction: string; amount: number }[];
  await inTransaction(t.pool, async (c) => {
    const id = await insertRow(c, "ledger_transactions", {
      kind: "reversal",
      reference_type: "ledger_transaction",
      reference_id: original,
      idempotency_key: "reversal:" + uniqueSuffix(),
      actor_type: "system",
    });
    for (const r of rows) {
      await insertRow(c, "ledger_entries", {
        transaction_id: id,
        account_id: r.account_id,
        direction: r.direction === "debit" ? "credit" : "debit",
        amount_minor: r.amount,
      });
    }
  });
};
const queue = (customerId: string, e: Parameters<CustomerRepos["invoices"]["queueBacklog"]>[0]) =>
  as(customerId, (r) => r.invoices.queueBacklog(e));
const queueOrder = async (customerId: string, orderId: string) =>
  queue(customerId, {
    id: uuidv7(),
    kind: "order",
    orderId,
    ledgerTransactionId: await orderTx(orderId),
    lines,
    totalMinor: 100n,
  });

beforeAll(async () => {
  await seedSeller(t.pool);
});

it("an order whose charge was reversed gets no invoice and no number; one already issued is replayed", async () => {
  const a = await newCustomer(t.pool);
  const reversedOrder = await newOrder(t.pool, a);
  await reverse(await orderTx(reversedOrder));
  const input = (orderId: string) => ({
    id: uuidv7(),
    orderId,
    fiscalYear: 2061,
    lines,
    totalMinor: 100n,
  });
  expect(await as(a, (r) => r.invoices.issue(input(reversedOrder)))).toEqual({
    ok: false,
    error: "charge_reversed",
  });
  expect(
    (await t.pool.query("select 1 from invoices where order_id = $1", [reversedOrder])).rowCount,
  ).toBe(0);
  // An invoice issued before the reversal is a legal document: the replay returns it unchanged.
  const issuedOrder = await newOrder(t.pool, a);
  const first = await as(a, (r) => r.invoices.issue(input(issuedOrder)));
  expect(first).toMatchObject({ ok: true, replayed: false });
  await reverse(await orderTx(issuedOrder));
  const again = await as(a, (r) => r.invoices.issue({ ...input(issuedOrder), id: uuidv7() }));
  expect(again).toMatchObject({ ok: true, replayed: true });
});

it("a renewal whose charge was reversed gets no invoice (issueForCharge)", async () => {
  const a = await newCustomer(t.pool);
  const charge = await newRenewalCharge(t.pool, a, 100);
  await reverse(charge);
  expect(
    await as(a, (r) =>
      r.invoices.issueForCharge({
        id: uuidv7(),
        ledgerTransactionId: charge,
        fiscalYear: 2062,
        lines,
        totalMinor: 100n,
      }),
    ),
  ).toEqual({ ok: false, error: "charge_reversed" });
});

it("the fiscal year and the date of issue come from one instant: the boundary of 1 July in Dhaka", async () => {
  const a = await newCustomer(t.pool);
  const issueAt = async (iso: string, fiscalYear: number) =>
    as(a, async (r) =>
      r.invoices.issue({
        id: uuidv7(),
        orderId: await newOrder(t.pool, a),
        fiscalYear,
        issuedAt: new Date(iso),
        lines,
        totalMinor: 100n,
      }),
    );
  // 2027-06-30T17:59:59.9Z is 23:59:59.9 on 30 June in Dhaka: fiscal year 2026.
  expect(await issueAt("2027-06-30T17:59:59.900Z", 2027)).toEqual({
    ok: false,
    error: "validation",
  });
  const before = await issueAt("2027-06-30T17:59:59.900Z", 2026);
  expect(before).toMatchObject({ ok: true, value: { fiscalYear: 2026 } });
  // 18:00:00.0Z is 00:00 on 1 July in Dhaka: fiscal year 2027.
  expect(await issueAt("2027-06-30T18:00:00.000Z", 2026)).toEqual({
    ok: false,
    error: "validation",
  });
  const after = await issueAt("2027-06-30T18:00:00.000Z", 2027);
  expect(after).toMatchObject({ ok: true, value: { fiscalYear: 2027 } });
  if (before.ok && after.ok) {
    expect(before.value.issuedAt.toISOString()).toBe("2027-06-30T17:59:59.900Z");
    expect(after.value.issuedAt.toISOString()).toBe("2027-06-30T18:00:00.000Z");
  }
});

it("a buyer name is counted in code points: 120 astral characters pass, 121 are refused", async () => {
  const a = await newCustomer(t.pool);
  const buyer = (name: string) => ({
    name,
    address: null,
    taxId: { kind: "bin" as const, value: "1234567890123" },
  });
  const issue = async (name: string) =>
    as(a, async (r) =>
      r.invoices.issue({
        id: uuidv7(),
        orderId: await newOrder(t.pool, a),
        fiscalYear: 2063,
        lines,
        totalMinor: 100n,
        buyer: buyer(name),
      }),
    );
  expect(await issue(astral.repeat(120))).toMatchObject({ ok: true });
  expect(await issue(astral.repeat(121))).toEqual({ ok: false, error: "validation" });
});

it("backlogBlocked: true while an older charge of the market waits, false when none does or in another market", async () => {
  await ensureMarket(t.pool, "OB");
  await ensureMarket(t.pool, "OC");
  const a = await newCustomer(t.pool, { market: "OB" });
  const same = await newCustomer(t.pool, { market: "OB" });
  const other = await newCustomer(t.pool, { market: "OC" });
  const blocked = (id: string) => as(id, (r) => r.invoices.backlogBlocked());
  expect(await blocked(a)).toBe(false);
  const order = await newOrder(t.pool, a);
  await queueOrder(a, order);
  expect(await blocked(a)).toBe(true);
  expect(await blocked(same)).toBe(true);
  expect(await blocked(other)).toBe(false);
  // Closed by a reversal, the queue no longer blocks.
  await reverse(await orderTx(order));
  expect(await blocked(same)).toBe(false);
});

it("pending flags a reversed charge; mark(resolved) closes the queue row for good, with its reason", async () => {
  await ensureMarket(t.pool, "OD");
  const a = await newCustomer(t.pool, { market: "OD" });
  const order = await newOrder(t.pool, a);
  await queueOrder(a, order);
  const txId = await orderTx(order);
  const pending = () => worker((tx) => invoiceBacklogRepo(tx).pending(50));
  expect((await pending()).items.find((i) => i.ledgerTransactionId === txId)?.reversed).toBe(false);
  await reverse(txId);
  const entry = (await pending()).items.find((i) => i.ledgerTransactionId === txId);
  expect(entry?.reversed).toBe(true);
  await worker((tx) =>
    invoiceBacklogRepo(tx).mark({
      discrepancyId: entry!.discrepancyId,
      ledgerTransactionId: txId,
      state: "resolved",
      reason: "charge_reversed",
    }),
  );
  expect((await pending()).items.find((i) => i.ledgerTransactionId === txId)).toBeUndefined();
  const rows = (
    await t.pool.query(
      "select status, details from discrepancies where details->>'ledgerTransactionId' = $1 order by created_at, id",
      [txId],
    )
  ).rows as { status: string; details: Record<string, unknown> }[];
  expect(rows.map((r) => r.status)).toEqual(["resolved", "resolved"]);
  expect(rows.find((r) => r.details["source"] === "invoice_backlog_mark")?.details).toMatchObject({
    state: "resolved",
    reason: "charge_reversed",
    for: entry!.discrepancyId,
  });
  // A second mark is a replay: one marker only (R7).
  await worker((tx) =>
    invoiceBacklogRepo(tx).mark({
      discrepancyId: entry!.discrepancyId,
      ledgerTransactionId: txId,
      state: "resolved",
      reason: "charge_reversed",
    }),
  );
  expect(
    (
      await t.pool.query(
        "select count(*)::int as n from discrepancies where details->>'for' = $1",
        [entry!.discrepancyId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("unreadable rows are marked skipped and the limit counts the readable ones only", async () => {
  await ensureMarket(t.pool, "OE");
  const a = await newCustomer(t.pool, { market: "OE" });
  const corrupt = [uuidv7(), uuidv7(), uuidv7()];
  for (const id of corrupt) {
    await insertRow(t.pool, "discrepancies", {
      id,
      kind: "missing",
      details: JSON.stringify({
        source: "invoice_seller_missing",
        v: 1,
        ledgerTransactionId: uuidv7(),
        customerId: "not-a-uuid",
      }),
    });
  }
  const o1 = await newOrder(t.pool, a);
  const o2 = await newOrder(t.pool, a);
  await queueOrder(a, o1);
  await queueOrder(a, o2);
  const all = await worker((tx) => invoiceBacklogRepo(tx).pending(100));
  const readable = all.items.length;
  expect(all.items.filter((i) => i.customerId === a)).toHaveLength(2);
  // the three corrupt rows are older than o1 and o2, yet a limit of the readable count still returns
  // all the readable ones: the unreadable rows do not use up the limit
  const first = await worker((tx) => invoiceBacklogRepo(tx).pending(readable));
  expect(first.items).toHaveLength(readable);
  expect(first.items.filter((i) => i.customerId === a)).toHaveLength(2);
  expect(first.unreadableIds.filter((id) => corrupt.includes(id)).sort()).toEqual(
    [...corrupt].sort(),
  );
  for (const id of first.unreadableIds) {
    await worker((tx) =>
      invoiceBacklogRepo(tx).mark({
        discrepancyId: id,
        ledgerTransactionId: null,
        state: "skipped",
        reason: "unreadable",
      }),
    );
  }
  const second = await worker((tx) => invoiceBacklogRepo(tx).pending(50));
  expect(second.unreadableIds.filter((id) => corrupt.includes(id))).toEqual([]);
  // the markers stay open: they are the notice for a person
  expect(
    (
      await t.pool.query(
        "select count(*)::int as n from discrepancies where status = 'open' and details->>'reason' = 'unreadable'",
      )
    ).rows[0].n,
  ).toBe(3);
});

it("creditNoteNeeded notes an issued invoice whose charge was reversed, once; nothing for a charge without an invoice", async () => {
  const a = await newCustomer(t.pool);
  const issued = await newOrder(t.pool, a);
  const plain = await newOrder(t.pool, a);
  await as(a, (r) =>
    r.invoices.issue({ id: uuidv7(), orderId: issued, fiscalYear: 2064, lines, totalMinor: 100n }),
  );
  const note = (tx: string) => worker((c) => invoiceBacklogRepo(c).creditNoteNeeded(tx));
  expect(await note(await orderTx(plain))).toBe(false);
  expect(await note(await orderTx(issued))).toBe(true);
  expect(await note(await orderTx(issued))).toBe(false);
  const rows = (
    await t.pool.query(
      "select kind, status, details from discrepancies where details->>'source' = 'credit_note_needed' and details->>'ledgerTransactionId' = $1",
      [await orderTx(issued)],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "missing", status: "open" });
  expect(rows[0].details).toMatchObject({
    customerId: a,
    fiscalYear: 2064,
    number: 1,
    totalMinor: "100",
  });
});

it("unrecorded lists a recent charge with no invoice, no queue row and no note; a queued one is left out", async () => {
  await ensureMarket(t.pool, "OF");
  const a = await newCustomer(t.pool, { market: "OF" });
  const lost = await newOrder(t.pool, a);
  const queued = await newOrder(t.pool, a);
  const renewal = await newRenewalCharge(t.pool, a, 100);
  await queueOrder(a, queued);
  const list = async () =>
    (await worker((tx) => invoiceBacklogRepo(tx).unrecorded(200, 7))).filter(
      (u) => u.customerId === a,
    );
  const found = await list();
  const lostTx = await orderTx(lost);
  expect(found.map((u) => u.ledgerTransactionId).sort()).toEqual([lostTx, renewal].sort());
  expect(found.find((u) => u.ledgerTransactionId === lostTx)).toMatchObject({
    kind: "order",
    orderId: lost,
    totalMinor: 100n,
  });
  expect(found.find((u) => u.ledgerTransactionId === renewal)).toMatchObject({
    kind: "renewal",
    orderId: null,
  });
  // a note closes it
  await as(a, (r) =>
    r.invoices.noteUnrecorded({
      id: uuidv7(),
      kind: "renewal",
      ledgerTransactionId: renewal,
      totalMinor: 100n,
    }),
  );
  expect((await list()).map((u) => u.ledgerTransactionId)).toEqual([lostTx]);
  // outside the window nothing is listed
  expect(
    (await worker((tx) => invoiceBacklogRepo(tx).unrecorded(200, 0))).filter(
      (u) => u.customerId === a,
    ),
  ).toEqual([]);
  void systemAccount;
});
