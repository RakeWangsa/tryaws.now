import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { isUuid } from "./scope";

// A job path (the failed hook of a create, as worker_rw), not a customer repository: the customer id
// is read from the operation row by the caller and compared with the order's own, and no function
// here takes a customer id from a request. It reads the tenant tables `orders`, `subscriptions` and
// `resources` by resource id (the id comes from the operation), like repositories/system/payments.ts.

export interface CompensationOrder {
  readonly orderId: string;
  readonly ledgerTransactionId: string;
  readonly customerId: string;
  readonly status: "paid" | "fulfilled" | "reversed";
}

export interface CompensationRepo {
  /** The order whose `items` name the resource, or null. */
  findOrderOfResource(resourceId: string): Promise<CompensationOrder | null>;
  /** `paid` to `reversed`; true only for the one call that flipped it. */
  markOrderReversed(orderId: string): Promise<boolean>;
  /** The subscription of the resource to `ended`; true when a row changed. */
  endSubscription(resourceId: string): Promise<boolean>;
  /** `creating` to `failed`; a no-op for a resource that is `failed` already. True when a row matched. */
  failResource(resourceId: string): Promise<boolean>;
}

function requireUuid(value: unknown): asserts value is string {
  // Fixed text: the refused value is never part of a message (R14).
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError("compensation: the id is not a UUID");
  }
}

export function compensationRepo(tx: Tx): CompensationRepo {
  return {
    findOrderOfResource: async (resourceId) => {
      requireUuid(resourceId);
      const { rows } = await tx.execute<{
        id: string;
        ledgerTransactionId: string;
        customerId: string;
        status: CompensationOrder["status"];
      }>(sql`select o.id, o.ledger_transaction_id as "ledgerTransactionId",
                    o.customer_id as "customerId", o.status
               from orders o
              where o.items @> ${JSON.stringify([{ resourceId }])}::jsonb
              order by o.created_at, o.id
              limit 1`);
      const row = rows[0];
      return row === undefined
        ? null
        : {
            orderId: row.id,
            ledgerTransactionId: row.ledgerTransactionId,
            customerId: row.customerId,
            status: row.status,
          };
    },

    markOrderReversed: async (orderId) => {
      requireUuid(orderId);
      const { rows } = await tx.execute<{ id: string }>(sql`update orders
           set status = 'reversed'
         where id = ${orderId} and status = 'paid'
        returning id`);
      return rows.length === 1;
    },

    endSubscription: async (resourceId) => {
      requireUuid(resourceId);
      const { rows } = await tx.execute<{ id: string }>(sql`update subscriptions
           set status = 'ended'
         where resource_id = ${resourceId} and status <> 'ended'
        returning id`);
      return rows.length > 0;
    },

    failResource: async (resourceId) => {
      requireUuid(resourceId);
      const { rows } = await tx.execute<{ id: string }>(sql`update resources
           set state = 'failed'
         where id = ${resourceId} and state in ('creating', 'failed')
        returning id`);
      return rows.length === 1;
    },
  };
}
