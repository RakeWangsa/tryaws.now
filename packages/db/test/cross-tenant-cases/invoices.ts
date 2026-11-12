import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { newOrder, newRenewalCharge, seedSeller } from "../fixtures";
import { insertRow } from "../sql";
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
    return {
      invoiceId,
      orderId,
      freeOrderId,
      renewalTx: await newRenewalCharge(pool, customerId),
      freeOrderTx,
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
  }),
});
