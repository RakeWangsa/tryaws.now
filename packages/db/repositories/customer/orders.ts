import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { orders } from "../../schema/index";
import type { ORDER_STATUSES } from "../../schema/money";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// An order of the customer, as the purchase and the order page read it. The customer id is not a
// field: the scope holds it (R8).
export interface OrderRow {
  id: string;
  kind: "new";
  items: unknown;
  priceSnapshot: unknown;
  totalMinor: bigint;
  ledgerTransactionId: string;
  idempotencyKey: string;
  status: (typeof ORDER_STATUSES)[number];
  createdAt: Date;
}

export interface NewPaidOrder {
  id: string;
  items: unknown;
  priceSnapshot: unknown;
  totalMinor: bigint;
  ledgerTransactionId: string;
  idempotencyKey: string;
}

export interface NewResource {
  id: string;
  family: string;
  productId: string;
  poolAccountId: string;
  region: string;
  config: Record<string, unknown>;
}

export interface NewSubscription {
  id: string;
  resourceId: string;
  termDays: number;
  priceSnapshot: unknown;
  periodStart: Date;
  periodEnd: Date;
}

// The three creates are the writes of the purchase transaction (WP4-T4). They run as web_rw, whose
// grants name the inserted columns: no created_at, no status, no state. The caller runs them inside
// the transaction in which it holds the wallet lock; a failure after the capacity reservation is a
// throw, so these return a Written only for what they can refuse themselves.
export interface OrdersRepo {
  get(id: string): Promise<OrderRow | null>;
  findByIdempotencyKey(key: string): Promise<OrderRow | null>;
  findByLedgerTransaction(transactionId: string): Promise<OrderRow | null>;
  createPaid(input: NewPaidOrder): Promise<Written<OrderRow>>;
  createResource(input: NewResource): Promise<Written<{ id: string }>>;
  createSubscription(input: NewSubscription): Promise<Written<{ id: string }>>;
}

// Selected by name; the customer id is not read back.
const ORDER_COLUMNS = {
  id: orders.id,
  kind: orders.kind,
  items: orders.items,
  priceSnapshot: orders.priceSnapshot,
  totalMinor: orders.totalMinor,
  ledgerTransactionId: orders.ledgerTransactionId,
  idempotencyKey: orders.idempotencyKey,
  status: orders.status,
  createdAt: orders.createdAt,
};

// The table holds only the values of its CHECKs, so narrowing kind and status is exact.
const toOrder = (row: Record<keyof OrderRow, unknown>): OrderRow => row as unknown as OrderRow;

// The same limit as the client key of the operations repository.
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

function requireUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !isUuid(value)) {
    // Fixed text: the refused value is never part of a message (R14).
    throw new TypeError(`orders: ${what} is not a UUID`);
  }
}

export function ordersRepo(scope: TenantScope): OrdersRepo {
  const { tx, customerId } = scope;

  const byColumn = async (
    column: typeof orders.id | typeof orders.idempotencyKey | typeof orders.ledgerTransactionId,
    value: string,
  ): Promise<OrderRow | null> => {
    const [row] = await tx
      .select(ORDER_COLUMNS)
      .from(orders)
      .where(and(eq(column, value), eq(orders.customerId, customerId)));
    return row === undefined ? null : toOrder(row);
  };

  return {
    // null for a missing row, a row of another customer and an id that is not a UUID alike (R8).
    get: async (id) => (isUuid(id) ? byColumn(orders.id, id) : null),

    // The key and the customer id are bound together: a key of another customer finds nothing.
    findByIdempotencyKey: async (key) =>
      typeof key === "string" && KEY_PATTERN.test(key)
        ? byColumn(orders.idempotencyKey, key)
        : null,

    findByLedgerTransaction: async (transactionId) =>
      isUuid(transactionId) ? byColumn(orders.ledgerTransactionId, transactionId) : null,

    createPaid: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.ledgerTransactionId, "ledgerTransactionId");
      if (
        typeof input.totalMinor !== "bigint" ||
        input.totalMinor < 0n ||
        typeof input.idempotencyKey !== "string" ||
        !KEY_PATTERN.test(input.idempotencyKey)
      ) {
        return refused("validation");
      }
      // The unique key (customer_id, idempotency_key) makes the call idempotent (R7). The status
      // is not inserted: the column default is paid.
      const inserted = await tx.execute(sql`
        insert into orders (id, customer_id, kind, items, price_snapshot, total_minor,
                            ledger_transaction_id, idempotency_key)
        values (${input.id}, ${customerId}, 'new', ${JSON.stringify(input.items)}::jsonb,
                ${JSON.stringify(input.priceSnapshot)}::jsonb, ${input.totalMinor.toString()}::bigint,
                ${input.ledgerTransactionId}, ${input.idempotencyKey})
        on conflict (customer_id, idempotency_key) do nothing`);
      if (inserted.rowCount === 1) {
        const row = await byColumn(orders.id, input.id);
        if (row === null) throw new Error("orders: the inserted order cannot be read");
        return created(row);
      }
      // The key is taken: the same purchase is a replay, another purchase is a conflict.
      const stored = await byColumn(orders.idempotencyKey, input.idempotencyKey);
      if (stored === null) throw new Error("orders: the order of the key cannot be read");
      return stored.ledgerTransactionId === input.ledgerTransactionId
        ? replayed(stored)
        : refused("conflict");
    },

    createResource: async (input) => {
      requireUuid(input.id, "id");
      requireUuid(input.productId, "productId");
      requireUuid(input.poolAccountId, "poolAccountId");
      // The state is not inserted: the column default is creating, and the grant forbids it.
      await tx.execute(sql`
        insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
        values (${input.id}, ${customerId}, ${input.family}, ${input.productId},
                ${input.poolAccountId}, ${input.region}, ${JSON.stringify(input.config)}::jsonb)`);
      return created({ id: input.id });
    },

    createSubscription: async (input) => {
      requireUuid(input.id, "id");
      if (!isUuid(input.resourceId)) return refused("not_found");
      if (!Number.isSafeInteger(input.termDays) || input.termDays <= 0) {
        return refused("validation");
      }
      // The resource is selected by id and customer in the same statement as the insert: a resource
      // of another customer, or a missing one, inserts nothing (R8). The customer id of the new row
      // is the resource's own, which the same condition ties to the scope.
      const inserted = await tx.execute(sql`
        insert into subscriptions (id, resource_id, customer_id, term_days, price_snapshot,
                                   period_start, period_end)
        select ${input.id}, r.id, r.customer_id, ${input.termDays},
               ${JSON.stringify(input.priceSnapshot)}::jsonb,
               ${input.periodStart.toISOString()}::timestamptz,
               ${input.periodEnd.toISOString()}::timestamptz
        from resources r
        where r.id = ${input.resourceId} and r.customer_id = ${customerId}`);
      return inserted.rowCount === 1 ? created({ id: input.id }) : refused("not_found");
    },
  };
}
