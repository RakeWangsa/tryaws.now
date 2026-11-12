import { and, desc, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { resources, supportRequests } from "../../schema/index";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// The customer's own support requests (16.10 /support when signed in, WP9-T4b). web_rw may INSERT
// id, customer_id, name, email, category, related_resource_id, subject, message and SELECT id,
// customer_id, category, related_resource_id, subject, message, status, created_at (0006). It has no
// UPDATE: the admin side answers and closes a request.
export interface NewSupportRequest {
  category: string;
  subject: string;
  message: string;
  /** A resource of this customer, or null. A resource of another customer is not_found (R8). */
  relatedResourceId: string | null;
  /** The idempotency key (R7): the row id is derived from the customer and this key. */
  idempotencyKey: string;
}

export interface CustomerSupportRequestRow {
  id: string;
  category: string;
  subject: string;
  status: string;
  createdAt: Date;
}

export interface SupportRepo {
  /** Newest first, at most `limit` (default 20, at most 100). Only columns web_rw may read. */
  list(limit?: number): Promise<CustomerSupportRequestRow[]>;
  create(input: NewSupportRequest): Promise<Written<{ id: string }>>;
}

const LIST_COLUMNS = {
  id: supportRequests.id,
  category: supportRequests.category,
  subject: supportRequests.subject,
  status: supportRequests.status,
  createdAt: supportRequests.createdAt,
};

// The id of a request: a UUID v5 of the idempotency key inside the namespace of the customer (a
// customer id is a UUID). The same customer and key give the same id on every call, so the primary
// key is the unique key of R7; another customer with the same key gets another id.
export function supportRequestId(customerId: string, idempotencyKey: string): string {
  return uuidv5(idempotencyKey, customerId);
}

export function supportRepo(scope: TenantScope): SupportRepo {
  return {
    list: async (limit = 20) =>
      scope.tx
        .select(LIST_COLUMNS)
        .from(supportRequests)
        .where(eq(supportRequests.customerId, scope.customerId))
        .orderBy(desc(supportRequests.createdAt), desc(supportRequests.id))
        .limit(Math.min(Math.max(Math.trunc(limit), 1), 100)),

    create: async (input) => {
      const id = supportRequestId(scope.customerId, input.idempotencyKey);
      const related = input.relatedResourceId;
      if (related !== null) {
        // A resource of another customer, a missing one and one that is not a UUID answer alike (R8).
        if (!isUuid(related)) return refused("not_found");
        const [own] = await scope.tx
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.id, related), eq(resources.customerId, scope.customerId)));
        if (own === undefined) return refused("not_found");
      }
      // The sql template names only the columns web_rw may insert (created_at and status take their
      // defaults). ON CONFLICT DO NOTHING, never a caught 23505, so the caller's transaction lives.
      const { rows } = await scope.tx.execute<{ id: string }>(sql`
        insert into support_requests
          (id, customer_id, category, related_resource_id, subject, message)
        values
          (${id}, ${scope.customerId}, ${input.category}, ${related}, ${input.subject},
           ${input.message})
        on conflict (id) do nothing
        returning id
      `);
      if (rows[0] !== undefined) return created({ id });

      const [existing] = await scope.tx
        .select({
          category: supportRequests.category,
          subject: supportRequests.subject,
          message: supportRequests.message,
          relatedResourceId: supportRequests.relatedResourceId,
        })
        .from(supportRequests)
        .where(and(eq(supportRequests.id, id), eq(supportRequests.customerId, scope.customerId)));
      // No row: the conflict was something else. Fail closed (R16).
      if (existing === undefined) return refused("conflict");
      return existing.category === input.category &&
        existing.subject === input.subject &&
        existing.message === input.message &&
        existing.relatedResourceId === related
        ? replayed({ id })
        : refused("conflict");
    },
  };
}
