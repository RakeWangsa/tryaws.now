import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { newOrder, newRenewalCharge, seedSeller } from "../fixtures";
import { inTransaction, insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface Seed {
  invoiceId: string;
  // An order that has this invoice, and one that has none (the target of issue).
  orderId: string;
  freeOrderId: string;
  // WPU-I2: a renewal charge of the customer (the target of issueForCharge), and the ledger
  // transaction of the free order (the target of queueBacklog).
  renewalTx: string;
  freeOrderTx: string;
  // WPU-C1: the reversal of a renewal of the customer that has an issued invoice (the target of
  // issueCreditNote).
  reversalTx: string;
}

// The number of the seeded invoice is random: the numbers are unique per fiscal year over the whole
// database, and A and B are seeded alike. issue() takes max + 1, which stays far below the int4 limit.
export const invoicesCases: CaseSet = defineCaseSet<Seed>({
  repo: "invoices",
  seed: async (pool, customerId) => {
    // WPU-I1: issue() needs the seller details of the customer's market (a shared market row).
    await seedSeller(pool, "BD");
    const orderId = await newOrder(pool, customerId);
    const invoiceId = await insertRow(pool, "invoices", {
      fiscal_year: 2026,
      number: randomInt(1, 900_000_000),
      customer_id: customerId,
      order_id: orderId,
      lines: "[]",
      total_minor: 100,
    });
    const freeOrderId = await newOrder(pool, customerId);
    const freeOrderTx = (
      await pool.query<{ id: string }>(
        "select ledger_transaction_id as id from orders where id = $1",
        [freeOrderId],
      )
    ).rows[0]!.id;
    // WPU-C1: a renewal with its invoice (the seller snapshot is the complete one of the market) and the
    // reversal of that renewal, which gives the wallet back the whole total.
    const creditedTx = await newRenewalCharge(pool, customerId);
    const seller = JSON.stringify({
      v: 1,
      version: 1,
      legalNameBn: "বি",
      legalNameEn: "S",
      bin: "0000000000000",
      addressBn: "ঠি",
      addressEn: "A",
      signatoryName: "N",
      signatoryDesignation: "D",
    });
    await insertRow(pool, "invoices", {
      fiscal_year: 2026,
      number: randomInt(1, 900_000_000),
      customer_id: customerId,
      lines: "[]",
      total_minor: 100,
      seller,
      ledger_transaction_id: creditedTx,
    });
    const reversalTx = await inTransaction(pool, async (c) => {
      const id = await insertRow(c, "ledger_transactions", {
        kind: "reversal",
        reference_type: "ledger_transaction",
        reference_id: creditedTx,
        idempotency_key: "reversal:" + creditedTx,
        actor_type: "system",
      });
      const lines = (
        await c.query<{ account_id: string; direction: string; amount_minor: string }>(
          "select account_id, direction, amount_minor::text from ledger_entries where transaction_id = $1",
          [creditedTx],
        )
      ).rows;
      for (const l of lines) {
        await insertRow(c, "ledger_entries", {
          transaction_id: id,
          account_id: l.account_id,
          direction: l.direction === "debit" ? "credit" : "debit",
          amount_minor: l.amount_minor,
        });
      }
      return id;
    });
    return {
      invoiceId,
      orderId,
      freeOrderId,
      renewalTx: await newRenewalCharge(pool, customerId),
      freeOrderTx,
      reversalTx,
    };
  },
  cases: ({ asCustomer }) => ({
    "invoices.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.invoices.get(s.invoiceId)),
    },
    "invoices.findByOrder": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.invoices.findByOrder(s.orderId)),
    },
    // Names no row: the list of B holds B's own invoices only, whatever the target is.
    "invoices.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.invoices.list()) },
    // The insert selects the order by id and customer in one statement: B's attempt on A's order is
    // not_found, like an attempt on a missing order, and takes no number.
    "invoices.issue": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.invoices.issue({
            id: uuidv7(),
            orderId: s.freeOrderId,
            fiscalYear: 2026,
            lines: [{ kind: "service", code: "aws" }],
            totalMinor: 100n,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // WPU-I2: the ledger transaction must be a renewal of the customer's own subscription.
    "invoices.issueForCharge": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.invoices.issueForCharge({
            id: uuidv7(),
            ledgerTransactionId: s.renewalTx,
            fiscalYear: 2026,
            lines: [{ kind: "service", code: "aws" }],
            totalMinor: 100n,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // WPU-C1: the reversal must be the reversal of the customer's own invoice. The insert is made by the
    // scheduler role only (the panel role has no grant on the credit note columns), so the proof is the
    // answer: B's attempt on A's reversal is not_found, like an attempt on a missing reversal, and takes
    // no number. A's own attempt with this role is refused by the grant, which is not the answer for a
    // missing row.
    "invoices.issueCreditNote": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.invoices.issueCreditNote({
            id: uuidv7(),
            reversalTransactionId: s.reversalTx,
            fiscalYear: 2026,
            issuedAt: new Date("2026-11-12T06:00:00Z"),
          }),
        )
          .then((w) => (w.ok ? { ok: true as const } : w))
          .catch((e: unknown) => ({
            ok: false as const,
            error: (e as { code?: string }).code === "42501" ? "denied" : "failed",
          })),
    },
    // WPU-I2: only a charge with a wallet debit of the customer in it is queued. It writes a row of the
    // admin queue (`discrepancies`, no tenant table), so the proof is the answer: A queues its own
    // charge, B's attempt on it answers like an attempt on a missing charge.
    "invoices.queueBacklog": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.invoices.queueBacklog({
            id: uuidv7(),
            kind: "order",
            orderId: s.freeOrderId,
            ledgerTransactionId: s.freeOrderTx,
            lines: [{ kind: "service", code: "aws" }],
            totalMinor: 100n,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // WPU-I5: the notice for a charge that has no lines: same ownership rule as queueBacklog.
    "invoices.noteUnrecorded": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.invoices.noteUnrecorded({
            id: uuidv7(),
            kind: "order",
            orderId: s.freeOrderId,
            ledgerTransactionId: s.freeOrderTx,
            totalMinor: 100n,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // WPU-I5: names no row; the customer id comes from the scope and the answer is one boolean about the
    // market's queue, whoever asks.
    "invoices.backlogBlocked": {
      kind: "read",
      run: (c, s) =>
        asCustomer(c, async (r) => {
          await r.invoices.backlogBlocked();
          return r.invoices.get(s.invoiceId);
        }),
    },
  }),
});
