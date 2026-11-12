// WPU-C1: the date of supply (ruling 5) and the credit note (ruling 6) against the real roles: web_rw (the
// panel), worker_rw (the scheduler). The credit note is issued by the scheduler for a reversed charge that has
// an issued invoice, in its own gap-free sequence, idempotent per reversal, refused when the reversal does not
// give back the whole invoice, and it never touches the original invoice or the ledger.
import { customerRepos, parseSellerRowValue } from "@tc/db";
import { runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { reverseTransaction } from "../ledger/reverse";
import { renewNow } from "../lifecycle/renew-now";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { runInvoiceBacklog } from "./backlog";
import { creditNoteIdFor, issueCreditNotes } from "./credit-note";
import { fiscalYearOf } from "./base";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWorker = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });
const asWeb = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "web_rw" });
let logs: Record<string, unknown>[] = [];
const deps = () => ({
  runTx: asWorker,
  clock: kit.clock,
  log: (e: Record<string, unknown>) => logs.push({ ...e }),
});
const sweep = () => runInvoiceBacklog(deps());

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
const ledgerOf = async (orderId: string): Promise<string> =>
  String(
    (await q("select ledger_transaction_id as id from orders where id = $1", [orderId]))[0]!.id,
  );
const invoiceByLedger = async (ltx: string) =>
  (await q("select * from invoices where ledger_transaction_id = $1", [ltx]))[0]!;
const creditNoteOf = async (ltx: string) =>
  (
    await q(
      `select c.* from invoices c join invoices o on o.id = c.original_invoice_id
        where c.kind = 'credit_note' and o.ledger_transaction_id = $1`,
      [ltx],
    )
  )[0];
const reversalOf = async (ltx: string): Promise<string> =>
  String(
    (
      await q("select id from ledger_transactions where kind = 'reversal' and reference_id = $1", [
        ltx,
      ])
    )[0]!.id,
  );
const reverse = (transactionId: string, orderId?: string) =>
  asWorker((tx) =>
    reverseTransaction(tx, {
      transactionId,
      ...(orderId === undefined ? {} : { orderId }),
      actor: { type: "system" },
    }),
  );
const ledgerCounts = async () =>
  (
    await q(
      `select (select count(*) from ledger_transactions)::int as tx, (select count(*) from ledger_entries)::int as entries,
              (select coalesce(sum(balance_minor), 0) from wallets)::text as wallets`,
    )
  )[0];
const noticeOf = async (ltx: string) =>
  (
    await q(
      "select status from discrepancies where details->>'source' = 'credit_note_needed' and details->>'ledgerTransactionId' = $1",
      [ltx],
    )
  )[0];

beforeAll(async () => {
  kit = await makeKit(t);
  await setSeller(SELLER);
  kit.clock.set(START);
});

describe("the date of supply on the invoice", () => {
  it("is the time of the ledger transaction of the charge, stored with the invoice, for an order", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    const inv = await invoiceByLedger(ltx);
    const lt = (await q("select created_at from ledger_transactions where id = $1", [ltx]))[0]!;
    expect(inv.kind).toBe("invoice");
    expect((inv.supply_at as Date).getTime()).toBe((lt.created_at as Date).getTime());
    expect(inv.original_invoice_id).toBeNull();
    expect(inv.credit_for_ledger_transaction_id).toBeNull();
    expect(inv.reason).toBeNull();
  });

  it("a backlog invoice shows the charge date; the date of issue is the later day; numbering follows the issue", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const { orderId } = await placeOne(kit, buyer);
    const ltx = await ledgerOf(orderId);
    expect(await q("select 1 from invoices where ledger_transaction_id = $1", [ltx])).toHaveLength(
      0,
    );
    await setSeller(SELLER);
    kit.clock.set(new Date(START.getTime() + 3 * DAY));
    expect(await sweep()).toMatchObject({ issued: 1 });
    const inv = await invoiceByLedger(ltx);
    const lt = (await q("select created_at from ledger_transactions where id = $1", [ltx]))[0]!;
    // The supply is the charge; the issue is the day the job issued it.
    expect((inv.supply_at as Date).getTime()).toBe((lt.created_at as Date).getTime());
    expect((inv.issued_at as Date).toISOString()).toBe(
      new Date(START.getTime() + 3 * DAY).toISOString(),
    );
    // The fiscal year follows the issue instant (WPU-I5).
    expect(inv.fiscal_year).toBe(fiscalYearOf(new Date(START.getTime() + 3 * DAY)));
    // The reader gives the same supply instant to the customer's page.
    const row = await asWeb((tx) =>
      customerRepos(tx, buyer.customerId).invoices.get(String(inv.id)),
    );
    expect(row?.supplyAt?.getTime()).toBe((lt.created_at as Date).getTime());
  });

  it("an invoice stored before the column existed (supply_at NULL) is read with the ledger time, and is not changed", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const { orderId } = await placeOne(kit, buyer);
    const ltx = await ledgerOf(orderId);
    await q("update invoices set supply_at = null where ledger_transaction_id = $1", [ltx]);
    const lt = (await q("select created_at from ledger_transactions where id = $1", [ltx]))[0]!;
    const id = String((await invoiceByLedger(ltx)).id);
    const row = await asWeb((tx) => customerRepos(tx, buyer.customerId).invoices.get(id));
    expect(row?.supplyAt?.getTime()).toBe((lt.created_at as Date).getTime());
    expect((await invoiceByLedger(ltx)).supply_at).toBeNull();
  });
});

describe("the credit note of a reversed charge", () => {
  it("is issued for a reversed order: copies of the original, own number, reason, notice resolved, original and ledger untouched", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const { orderId } = await placeOne(kit, buyer);
    const ltx = await ledgerOf(orderId);
    const original = await invoiceByLedger(ltx);
    expect((await reverse(ltx)).ok).toBe(true);
    expect((await noticeOf(ltx))?.status).toBe("open");
    // The seller details change after the original was issued: the credit note keeps the original's.
    await setSeller({ ...SELLER, version: 2, legalNameEn: "Renamed Limited" });
    kit.clock.set(new Date(START.getTime() + 2 * DAY));
    const ledgerBefore = await ledgerCounts();

    const report = await sweep();
    expect(report).toMatchObject({ creditNotesIssued: 1 });
    const note = (await creditNoteOf(ltx))!;
    expect(note).toBeDefined();
    expect(note.kind).toBe("credit_note");
    expect(note.original_invoice_id).toBe(original.id);
    expect(note.credit_for_ledger_transaction_id).toBe(await reversalOf(ltx));
    expect(note.id).toBe(creditNoteIdFor(await reversalOf(ltx)));
    expect(note.reason).toBe("refund");
    expect(note.customer_id).toBe(buyer.customerId);
    expect(note.order_id).toBeNull();
    expect(note.ledger_transaction_id).toBeNull();
    expect(note.supply_at).toBeNull();
    // Copied in full, never recomputed or re-read from the settings.
    expect(note.lines).toEqual(original.lines);
    expect(note.total_minor).toBe(original.total_minor);
    expect(note.buyer).toEqual(original.buyer);
    expect(note.seller).toEqual(original.seller);
    expect(parseSellerRowValue(note.seller)?.seller.legalNameEn).toBe("Test Limited");
    expect((note.issued_at as Date).toISOString()).toBe(
      new Date(START.getTime() + 2 * DAY).toISOString(),
    );
    expect(note.fiscal_year).toBe(2026);
    expect(note.number).toBe(1);
    // The notice is resolved by the issue.
    expect((await noticeOf(ltx))?.status).toBe("resolved");
    // The old invoice is unchanged; the ledger is untouched by the credit note.
    expect(await invoiceByLedger(ltx)).toEqual(original);
    expect(await ledgerCounts()).toEqual(ledgerBefore);
  });

  it("is issued for a reversed renewal", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer({ balanceMinor: 20_000_000n });
    const { resourceId } = await placeOne(kit, buyer);
    const s = (
      await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
    )[0]!;
    await q("update resources set state = 'active' where id = $1", [resourceId]);
    await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
    kit.clock.set(new Date((s.period_end as Date).getTime() - 2 * DAY));
    expect(
      (
        await asWeb((tx) =>
          renewNow(tx, { customerId: buyer.customerId, resourceId, clock: kit.clock }),
        )
      ).ok,
    ).toBe(true);
    const ltx = String(
      (
        await q("select id from ledger_transactions where kind = 'renewal' and reference_id = $1", [
          s.id,
        ])
      )[0]!.id,
    );
    const renewalInvoice = await invoiceByLedger(ltx);
    expect(renewalInvoice.order_id).toBeNull();
    expect((await reverse(ltx)).ok).toBe(true);
    expect(await sweep()).toMatchObject({ creditNotesIssued: 1 });
    const note = (await creditNoteOf(ltx))!;
    expect(note.original_invoice_id).toBe(renewalInvoice.id);
    expect(note.lines).toEqual(renewalInvoice.lines);
    expect(note.reason).toBe("refund");
  });

  it("the reason is order_failed for the automatic reversal of a failed create", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx, orderId)).ok).toBe(true);
    await sweep();
    expect((await creditNoteOf(ltx))?.reason).toBe("order_failed");
  });

  it("the reason is plan_change_not_delivered when the reversal says so", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect(
      (
        await asWorker((tx) =>
          reverseTransaction(tx, {
            transactionId: ltx,
            actor: { type: "system" },
            memo: "plan_change_not_delivered",
          }),
        )
      ).ok,
    ).toBe(true);
    await sweep();
    expect((await creditNoteOf(ltx))?.reason).toBe("plan_change_not_delivered");
  });

  it("a repeat of the run makes no second credit note and takes no number", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    expect((await reverse(ltx)).ok).toBe(true); // a replay of the reversal
    await sweep();
    const first = (await creditNoteOf(ltx))!;
    const before = await q(
      "select count(*)::int as n, max(number) as top from invoices where kind = 'credit_note'",
    );
    const again = await sweep();
    expect(again).toMatchObject({ creditNotesIssued: 0 });
    const after = await q(
      "select count(*)::int as n, max(number) as top from invoices where kind = 'credit_note'",
    );
    expect(after).toEqual(before);
    expect(await creditNoteOf(ltx)).toEqual(first);
    // The same call again is a replay of the same row (R7).
    const replay = await asWorker((tx) =>
      customerRepos(tx, String(first.customer_id)).invoices.issueCreditNote({
        id: creditNoteIdFor(String(first.credit_for_ledger_transaction_id)),
        reversalTransactionId: String(first.credit_for_ledger_transaction_id),
        fiscalYear: 2026,
        issuedAt: kit.clock.now(),
      }),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
  });

  it("numbers are gap-free per fiscal year under a failed issue, and apart from the invoice numbers", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const a = await placeOne(kit, await kit.newBuyer());
    const b = await placeOne(kit, await kit.newBuyer());
    const ltxA = await ledgerOf(a.orderId);
    const ltxB = await ledgerOf(b.orderId);
    expect((await reverse(ltxA)).ok).toBe(true);
    expect((await reverse(ltxB)).ok).toBe(true);
    const top = async (kind: string) =>
      Number(
        (
          await q(
            "select coalesce(max(number), 0)::int as n from invoices where kind = $1 and fiscal_year = 2026",
            [kind],
          )
        )[0]!.n,
      );
    const noteTop = await top("credit_note");
    const invoiceTop = await top("invoice");

    // An issue that takes a number and then fails: the transaction rolls back and the number is free.
    const customerA = String((await invoiceByLedger(ltxA)).customer_id);
    await expect(
      asWorker(async (tx) => {
        const r = await customerRepos(tx, customerA).invoices.issueCreditNote({
          id: creditNoteIdFor(await reversalOf(ltxA)),
          reversalTransactionId: await reversalOf(ltxA),
          fiscalYear: 2026,
          issuedAt: kit.clock.now(),
        });
        expect(r.ok).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await creditNoteOf(ltxA)).toBeUndefined();

    await sweep();
    const numbers = [(await creditNoteOf(ltxA))!.number, (await creditNoteOf(ltxB))!.number].sort();
    expect(numbers).toEqual([noteTop + 1, noteTop + 2]);
    // The credit notes did not move the invoice sequence: the next invoice is the next number.
    expect(await top("invoice")).toBe(invoiceTop);
    const next = await placeOne(kit, await kit.newBuyer());
    expect(Number((await invoiceByLedger(await ledgerOf(next.orderId))).number)).toBe(
      invoiceTop + 1,
    );
  });

  it("is refused when the reversal does not equal the invoice total (a partial credit is not built); the notice stays open", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    // The invoice's total no longer matches what the reversal gave back.
    await q("update invoices set total_minor = total_minor + 1 where ledger_transaction_id = $1", [
      ltx,
    ]);
    logs = [];
    const before = await q("select count(*)::int as n from invoices where kind = 'credit_note'");
    const report = await sweep();
    expect(report.creditNotesIssued).toBe(0);
    expect(await creditNoteOf(ltx)).toBeUndefined();
    expect(await q("select count(*)::int as n from invoices where kind = 'credit_note'")).toEqual(
      before,
    );
    expect((await noticeOf(ltx))?.status).toBe("open");
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "credit_note_refused",
        reason: "amount_mismatch",
        ledgerTransactionId: ltx,
      }),
    );
    // Ids and a fixed code only (R14).
    expect(JSON.stringify(logs)).not.toMatch(/Rahim|@|\+880/);
  });

  it("fails closed when the seller snapshot of the original is missing: nothing issued, no number taken", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    await q("update invoices set seller = null where ledger_transaction_id = $1", [ltx]);
    // The current settings are complete, and still the credit note is not made from them.
    await setSeller(SELLER);
    logs = [];
    const top = (
      await q("select coalesce(max(number), 0)::int as n from invoices where kind = 'credit_note'")
    )[0]!.n;
    await sweep();
    expect(await creditNoteOf(ltx)).toBeUndefined();
    expect(
      (
        await q(
          "select coalesce(max(number), 0)::int as n from invoices where kind = 'credit_note'",
        )
      )[0]!.n,
    ).toBe(top);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "credit_note_refused", reason: "seller_details_missing" }),
    );
  });

  it("a charge that was never invoiced gets no credit note", async () => {
    await setSeller(null);
    kit.clock.set(START);
    const { orderId } = await placeOne(kit, await kit.newBuyer());
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    await setSeller(SELLER);
    await sweep();
    expect(await creditNoteOf(ltx)).toBeUndefined();
    expect(await q("select 1 from invoices where ledger_transaction_id = $1", [ltx])).toHaveLength(
      0,
    );
  });
});

describe("tenant scoping and roles (R8)", () => {
  it("another customer's reversal answers not_found; their credit note reads as missing; /invoices lists it for the owner only", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const owner = await kit.newBuyer();
    const other = await kit.newBuyer();
    const { orderId } = await placeOne(kit, owner);
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    const rev = await reversalOf(ltx);

    const stranger = await asWorker((tx) =>
      customerRepos(tx, other.customerId).invoices.issueCreditNote({
        id: creditNoteIdFor(rev),
        reversalTransactionId: rev,
        fiscalYear: 2026,
        issuedAt: kit.clock.now(),
      }),
    );
    expect(stranger).toEqual({ ok: false, error: "not_found" });
    expect(await creditNoteOf(ltx)).toBeUndefined();

    await sweep();
    const note = (await creditNoteOf(ltx))!;
    const id = String(note.id);
    const seen = await asWeb((tx) => customerRepos(tx, other.customerId).invoices.get(id));
    expect(seen).toBeNull();
    const own = await asWeb((tx) => customerRepos(tx, owner.customerId).invoices.get(id));
    expect(own).toMatchObject({
      kind: "credit_note",
      originalInvoiceId: String((await invoiceByLedger(ltx)).id),
      reason: "refund",
    });
    const ownList = await asWeb((tx) => customerRepos(tx, owner.customerId).invoices.list());
    expect(ownList.items.map((i) => i.kind).sort()).toEqual(["credit_note", "invoice"]);
    const otherList = await asWeb((tx) => customerRepos(tx, other.customerId).invoices.list());
    expect(otherList.items).toEqual([]);
  });

  it("the web role cannot write the credit note columns (only the scheduler issues credit notes)", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer();
    const { orderId } = await placeOne(kit, buyer);
    const ltx = await ledgerOf(orderId);
    expect((await reverse(ltx)).ok).toBe(true);
    const rev = await reversalOf(ltx);
    await expect(
      asWeb((tx) =>
        customerRepos(tx, buyer.customerId).invoices.issueCreditNote({
          id: creditNoteIdFor(rev),
          reversalTransactionId: rev,
          fiscalYear: 2026,
          issuedAt: kit.clock.now(),
        }),
      ),
    ).rejects.toThrow();
    expect(await creditNoteOf(ltx)).toBeUndefined();
  });

  it("the list pages through invoices and credit notes with a key of (year, kind, number)", async () => {
    await setSeller(SELLER);
    kit.clock.set(START);
    const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
    const placed = [];
    for (let i = 0; i < 3; i += 1) placed.push(await placeOne(kit, buyer));
    for (const p of placed.slice(0, 2))
      expect((await reverse(await ledgerOf(p.orderId))).ok).toBe(true);
    await sweep();
    const seen: string[] = [];
    let after: Parameters<ReturnType<typeof customerRepos>["invoices"]["list"]>[0] extends infer O
      ? O extends { after?: infer A }
        ? A
        : never
      : never;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await asWeb((tx) =>
        customerRepos(tx, buyer.customerId).invoices.list({
          limit: 2,
          ...(after ? { after } : {}),
        }),
      );
      seen.push(...page.items.map((i) => `${i.kind}:${i.number}`));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe("issueCreditNotes", () => {
  it("never throws: a broken database call is logged with a fixed name", async () => {
    const out = await issueCreditNotes(
      {
        runTx: async () => {
          throw new Error("down");
        },
        clock: kit.clock,
        log: (e) => logs.push({ ...e }),
      },
      10,
    );
    expect(out).toEqual({ issued: 0, replayed: 0, refused: 0, stuck: 0 });
  });
});
