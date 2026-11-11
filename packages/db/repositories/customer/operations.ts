import { sql } from "drizzle-orm";
import { readApprovalUntil } from "../../operations/approval";
import { operationInsertValues, type OperationInsertValues } from "../../operations/insert";
import { isOperationKind, OPERATION_KIND_INFO, type OperationKind } from "../../operations/kinds";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// An operation of the customer's own resource, with only the columns that web_rw may SELECT
// (migration 0006): no attempts, next_run_at, approved_by, last_error or payload, and no
// idempotency_key or enqueue_seq (open point 13). An operation that waits for approval has the
// state "needs_approval".
export interface CustomerOperation {
  id: string;
  resourceId: string;
  kind: string;
  state: string;
  step: string | null;
  needsApproval: boolean;
  createdAt: Date;
}

export interface OperationRequest {
  resourceId: string;
  kind: OperationKind;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  // D21: the table kind -> approval decides. true raises the gate; false and undefined never lower it.
  needsApproval?: boolean;
}

// The key as it is stored. It carries the customer, so two customers never collide on the
// platform-wide unique index operations_idempotency_key_unique, and the replay lookup cannot find the
// row of another customer. The keys of system jobs never start with "customer:" (open point 7).
export function customerOperationKey(customerId: string, key: string): string {
  return `customer:${customerId}:${key}`;
}

// operations has no customer_id: every statement reaches it through its resource, in the same
// statement (R8). `request` is a second insert path next to enqueueOperation of F (open point 7); it
// inserts the row only, and the caller sends the queue message after the commit (3.4).
export interface OperationsRepo {
  get(id: string): Promise<CustomerOperation | null>;
  listForResource(resourceId: string): Promise<CustomerOperation[]>;
  // The customer's newest operations over all its resources (the dashboard), at most 50.
  listRecent(limit?: number): Promise<CustomerOperation[]>;
  request(input: OperationRequest): Promise<Written<CustomerOperation>>;
}

// The columns of CustomerOperation, for every statement of this file (alias o). Only columns web_rw
// may SELECT: no attempts, next_run_at, approved_by, payload, last_error. A raw statement returns the
// SQL column names, so each one is aliased to its camelCase name.
const OPERATION_COLUMNS = sql`o.id, o.resource_id as "resourceId", o.kind, o.state, o.step,
  o.needs_approval as "needsApproval", o.created_at as "createdAt"`;

// A raw row: timestamptz comes back as text (drizzle-orm keeps the text of date and time columns for
// tx.execute), so createdAt is mapped with new Date, as Drizzle's own select does.
type OperationRow = {
  id: string;
  resourceId: string;
  kind: string;
  state: string;
  step: string | null;
  needsApproval: boolean;
  createdAt: string;
};

// Field by field, so that the extra column of the replay lookup (sameRequest) never leaves this file.
const toOperation = (row: OperationRow): CustomerOperation => ({
  id: row.id,
  resourceId: row.resourceId,
  kind: row.kind,
  state: row.state,
  step: row.step,
  needsApproval: row.needsApproval,
  createdAt: new Date(row.createdAt),
});

// The client key: at most 128 characters, so that "customer:" + a UUID + ":" + the key stays within
// the 200 characters that operationInsertValues allows.
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

// A customer asks only for the kinds that OPERATION_KIND_INFO marks as customer-requestable. The
// database does not limit the kind, so this is the one check (R8, R16).
const isCustomerKind = (kind: unknown): kind is OperationKind =>
  isOperationKind(kind) && OPERATION_KIND_INFO[kind].customerRequestable;

export function operationsRepo(scope: TenantScope): OperationsRepo {
  return {
    // null for a missing operation, an operation of another customer and an id that is not a UUID alike.
    get: async (id) => {
      if (!isUuid(id)) return null;
      const { rows } = await scope.tx.execute<OperationRow>(sql`
        select ${OPERATION_COLUMNS}
        from operations o join resources r on r.id = o.resource_id
        where o.id = ${id} and r.customer_id = ${scope.customerId}`);
      const [row] = rows;
      return row === undefined ? null : toOperation(row);
    },

    // Newest first. [] for a resource of another customer, a missing one and an id that is not a UUID.
    listForResource: async (resourceId) => {
      if (!isUuid(resourceId)) return [];
      const { rows } = await scope.tx.execute<OperationRow>(sql`
        select ${OPERATION_COLUMNS}
        from operations o join resources r on r.id = o.resource_id
        where o.resource_id = ${resourceId} and r.customer_id = ${scope.customerId}
        order by o.created_at desc, o.id desc`);
      return rows.map(toOperation);
    },

    listRecent: async (limit = 5) => {
      const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 5;
      const { rows } = await scope.tx.execute<OperationRow>(sql`
        select ${OPERATION_COLUMNS}
        from operations o join resources r on r.id = o.resource_id
        where r.customer_id = ${scope.customerId}
        order by o.created_at desc, o.id desc
        limit ${bounded}`);
      return rows.map(toOperation);
    },

    request: async (input) => {
      // The checks answer before any query, in this order.
      if (
        typeof input.idempotencyKey !== "string" ||
        !CLIENT_KEY_PATTERN.test(input.idempotencyKey)
      ) {
        return refused("validation");
      }
      if (!isUuid(input.resourceId)) return refused("not_found");
      if (!isCustomerKind(input.kind)) return refused("validation");

      // The one function of defaults for both insert paths: the flag comes from the kind and the
      // date, and the caller can only raise it (D21, R13).
      const until = await readApprovalUntil(scope.tx);
      let values: OperationInsertValues;
      try {
        values = operationInsertValues(
          {
            resourceId: input.resourceId,
            kind: input.kind,
            payload: input.payload ?? {},
            idempotencyKey: customerOperationKey(scope.customerId, input.idempotencyKey),
            needsApproval: input.needsApproval,
          },
          new Date(),
          until,
        );
      } catch (error) {
        if (error instanceof RangeError) return refused("validation");
        throw error;
      }

      // The sql template, not a Drizzle insert(): a Drizzle insert names step, attempts, enqueue_seq,
      // next_run_at, last_error, approved_by and created_at, which web_rw may not insert. The row
      // comes from the resource of this customer, so another customer's resource inserts nothing.
      // On a taken key it does nothing and raises no unique violation, which would abort the caller's
      // transaction.
      const inserted = await scope.tx.execute<OperationRow>(sql`
        insert into operations as o (id, resource_id, kind, state, idempotency_key, payload, needs_approval)
        select ${values.id}, r.id, ${values.kind}, ${values.state}, ${values.idempotencyKey}, ${values.payloadJson}::jsonb, ${values.needsApproval}
        from resources r
        where r.id = ${values.resourceId} and r.customer_id = ${scope.customerId}
          and (${values.kind} <> 'delete_backup'
               or (r.family = 'backup' and (r.config ->> 'final') is distinct from 'true'))
        on conflict (idempotency_key) do nothing
        returning ${OPERATION_COLUMNS}`);
      const [row] = inserted.rows;
      if (row !== undefined) return created(toOperation(row));

      // No row: the resource is not the customer's (or the key is taken). Look the key up through
      // the customer's resources. The payload is not compared, because web_rw has no SELECT on it
      // (open point 8): a replay with another payload answers with the stored row. The flag is not
      // compared either: it is derived from the kind and the date, so it can differ between two
      // sends of the same request.
      const found = await scope.tx.execute<OperationRow & { sameRequest: boolean }>(sql`
        select ${OPERATION_COLUMNS},
          (o.resource_id = ${values.resourceId}::uuid and o.kind = ${values.kind}) as "sameRequest"
        from operations o join resources r on r.id = o.resource_id
        where o.idempotency_key = ${values.idempotencyKey} and r.customer_id = ${scope.customerId}`);
      const [existing] = found.rows;
      if (existing === undefined) return refused("not_found");
      return existing.sameRequest ? replayed(toOperation(existing)) : refused("conflict");
    },
  };
}
