import { v7 as uuidv7 } from "uuid";
import { uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

// Every run gets its own payment row to act on: the cases are run as the owner, as another customer
// and as the other customer on a missing row, each with fresh customers (see testing/cross-tenant.ts).
const seedPayment = (pool: Parameters<typeof insertRow>[0], customerId: string) =>
  insertRow(pool, "payments", {
    customer_id: customerId,
    gateway: "eps",
    merchant_transaction_id: "MTX-" + uniqueSuffix() + uniqueSuffix(),
    idempotency_key: "seed-" + uniqueSuffix(),
    amount_minor: 15_000,
    currency: "BDT",
  });

export const paymentsCases: CaseSet = defineCaseSet<{ customerId: string; paymentId: string }>({
  repo: "payments",
  seed: async (pool, customerId) => ({
    customerId,
    paymentId: await seedPayment(pool, customerId),
  }),
  cases: ({ asCustomer }) => ({
    // A fresh id, merchant transaction id and key on every call; the amount is fixed text.
    "payments.insert": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.payments.insert({
            id: uuidv7(),
            merchantTransactionId: "MTX-" + uuidv7(),
            idempotencyKey: uuidv7(),
            amountMinor: 25_000n,
            currency: "BDT",
            gateway: "eps",
          }),
        ),
    },
    "payments.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.payments.get(s.paymentId)),
    },
    "payments.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.payments.list(100)) },
    "payments.markRedirected": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.payments.markRedirected(s.paymentId, "EPS-GW-0001")),
    },
    "payments.markFailed": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.payments.markFailed(s.paymentId)),
    },
  }),
});
