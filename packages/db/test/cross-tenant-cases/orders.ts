import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ghostOf } from "../../testing/cross-tenant";
import { newLedgerTransaction, newResource, newPoolAccount, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface Seed {
  orderId: string;
  idempotencyKey: string;
  ledgerTransactionId: string;
  resourceId: string;
  productId: string;
  poolAccountId: string;
}

// createPaid needs a ledger transaction of the caller's own that no order uses yet. The seed keeps
// the pool, because a run has only the repositories.
let seedPool: pg.Pool | undefined;

export const ordersCases: CaseSet = defineCaseSet<Seed>({
  repo: "orders",
  seed: async (pool, customerId) => {
    seedPool = pool;
    const ledgerTransactionId = await newLedgerTransaction(pool, customerId);
    const idempotencyKey = "seed-key-" + uniqueSuffix();
    const orderId = await insertRow(pool, "orders", {
      customer_id: customerId,
      kind: "new",
      items: "[]",
      price_snapshot: "{}",
      total_minor: 100,
      ledger_transaction_id: ledgerTransactionId,
      idempotency_key: idempotencyKey,
    });
    return {
      orderId,
      idempotencyKey,
      ledgerTransactionId,
      resourceId: await newResource(pool, customerId),
      productId: await insertRow(pool, "catalog_products", {
        family: "instance",
        aws_id: "seed-" + uniqueSuffix(),
        region: "ap-south-1",
        aws_price_usd: "1",
        billing_unit: "month",
        feature_flag: "linux_instance",
        synced_at: "2026-11-11T00:00:00Z",
      }),
      poolAccountId: await newPoolAccount(pool),
    };
  },
  cases: ({ asCustomer }) => ({
    "orders.get": { kind: "read", run: (c, s) => asCustomer(c, (r) => r.orders.get(s.orderId)) },
    // The key holds no UUID, so the ghost names another key by hand.
    "orders.findByIdempotencyKey": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.orders.findByIdempotencyKey(s.idempotencyKey)),
      ghost: (s) => ({ ...ghostOf(s), idempotencyKey: "ghost-key-" + uniqueSuffix() }),
    },
    "orders.findByLedgerTransaction": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.orders.findByLedgerTransaction(s.ledgerTransactionId)),
    },
    // A fresh key and a fresh ledger transaction of the actor on every call. B writes its own row;
    // that B can also reuse A's key without touching A's row is proven in orders-repo.test.ts.
    "orders.createPaid": {
      kind: "self-write",
      run: async (c) => {
        if (seedPool === undefined) throw new Error("the case set has not been seeded");
        const ledgerTransactionId = await newLedgerTransaction(seedPool, c);
        return asCustomer(c, (r) =>
          r.orders.createPaid({
            id: uuidv7(),
            items: [],
            priceSnapshot: {},
            totalMinor: 100n,
            ledgerTransactionId,
            idempotencyKey: "cross-" + uniqueSuffix(),
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w));
      },
    },
    "orders.createResource": {
      kind: "self-write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.orders.createResource({
            id: uuidv7(),
            family: "instance",
            productId: s.productId,
            poolAccountId: s.poolAccountId,
            region: "ap-south-1",
            config: {},
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
    // The insert selects the resource by id and customer in one statement: B's attempt on A's
    // resource is not_found, like an attempt on a missing resource, and writes nothing.
    "orders.createSubscription": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.orders.createSubscription({
            id: uuidv7(),
            resourceId: s.resourceId,
            termDays: 30,
            priceSnapshot: {},
            periodStart: new Date("2026-11-11T10:00:00.000Z"),
            periodEnd: new Date("2026-12-11T10:00:00.000Z"),
            autoRenew: true,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
  }),
});
