import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { newOrder } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface Seed {
  invoiceId: string;
  // An order that has this invoice, and one that has none (the target of issue).
  orderId: string;
  freeOrderId: string;
}

// The number of the seeded invoice is random: the numbers are unique per fiscal year over the whole
// database, and A and B are seeded alike. issue() takes max + 1, which stays far below the int4 limit.
export const invoicesCases: CaseSet = defineCaseSet<Seed>({
  repo: "invoices",
  seed: async (pool, customerId) => {
    const orderId = await newOrder(pool, customerId);
    const invoiceId = await insertRow(pool, "invoices", {
      fiscal_year: 2026,
      number: randomInt(1, 900_000_000),
      customer_id: customerId,
      order_id: orderId,
      lines: "[]",
      total_minor: 100,
    });
    return { invoiceId, orderId, freeOrderId: await newOrder(pool, customerId) };
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
  }),
});
