import { sql } from "drizzle-orm";
import { readApprovalUntil } from "../../operations/approval";
import { liveDestroyOf, operationInsertValues } from "../../operations/insert";
import { customerOperationKey } from "./operations";
import { created, refused, replayed, type Written } from "../result";
import { retainAttachedDisks } from "../system/attached-disks";
import { isUuid, type TenantScope } from "../scope";

// The subscription of one of the customer's resources, as the Billing tab, the dashboard and the
// destroy flow read it. The customer id is not a field: the scope holds it (R8). `priceSnapshot` is
// the stored pricing snapshot (amounts as decimal text); the screens parse it with @tc/core.
import type { SubscriptionStatus } from "../system/lifecycle";

export interface SubscriptionRow {
  id: string;
  resourceId: string;
  termDays: number;
  priceSnapshot: unknown;
  periodStart: Date;
  periodEnd: Date;
  autoRenew: boolean;
  status: SubscriptionStatus;
}

export interface DestroyRequest {
  resourceId: string;
  // The client key of the request (the form's idempotency key); stored with the customer prefix.
  idempotencyKey: string;
  // true where the family has snapshots (SNAPSHOT_FAMILIES of @tc/core): a final snapshot comes
  // first and the destroy waits behind it (R13).
  withFinalSnapshot: boolean;
}

export interface DestroyQueued {
  destroyOperationId: string;
  finalSnapshotOperationId: string | null;
  needsApproval: boolean;
}

export interface SubscriptionsRepo {
  get(resourceId: string): Promise<SubscriptionRow | null>;
  list(): Promise<SubscriptionRow[]>;
  // The renewal switch. `not_found` for a resource that is not the customer's.
  setAutoRenew(resourceId: string, on: boolean): Promise<Written<SubscriptionRow>>;
  // 11 and R13, the customer's own destroy: the subscription becomes `retained`, the final snapshot
  // is queued where the family has one, then the destroy (which waits for an admin before the end
  // date of R13, and which the guard checks again when it is claimed). One transaction, one key:
  // a repeat answers with the stored operations. WPU-Y4: the disks attached to the resource are retained
  // with it and get their own final snapshot and destroy (retainAttachedDisks).
  requestDestroy(input: DestroyRequest): Promise<Written<DestroyQueued>>;
}

type Row = {
  id: string;
  resourceId: string;
  termDays: number;
  priceSnapshot: unknown;
  periodStart: string;
  periodEnd: string;
  autoRenew: boolean;
  status: string;
};

const COLUMNS = sql`s.id, s.resource_id as "resourceId", s.term_days as "termDays",
  s.price_snapshot as "priceSnapshot", s.period_start as "periodStart", s.period_end as "periodEnd",
  s.auto_renew as "autoRenew", s.status`;

const toRow = (row: Row): SubscriptionRow => ({
  id: row.id,
  resourceId: row.resourceId,
  termDays: row.termDays,
  priceSnapshot: row.priceSnapshot,
  periodStart: new Date(row.periodStart),
  periodEnd: new Date(row.periodEnd),
  autoRenew: row.autoRenew,
  status: row.status as SubscriptionStatus,
});

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,100}$/;

export function subscriptionsRepo(scope: TenantScope): SubscriptionsRepo {
  const { tx, customerId } = scope;
  return {
    // null for a missing row, another customer's row and an id that is not a UUID alike.
    get: async (resourceId) => {
      if (!isUuid(resourceId)) return null;
      const { rows } = await tx.execute<Row>(sql`
        select ${COLUMNS} from subscriptions s
        where s.resource_id = ${resourceId} and s.customer_id = ${customerId}`);
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    list: async () => {
      const { rows } = await tx.execute<Row>(sql`
        select ${COLUMNS} from subscriptions s
        where s.customer_id = ${customerId}
        order by s.period_end, s.id`);
      return rows.map(toRow);
    },

    setAutoRenew: async (resourceId, on) => {
      if (!isUuid(resourceId) || typeof on !== "boolean") return refused("not_found");
      const { rows } = await tx.execute<Row>(sql`
        update subscriptions s set auto_renew = ${on}
        where s.resource_id = ${resourceId} and s.customer_id = ${customerId}
        returning ${COLUMNS}`);
      return rows[0] === undefined ? refused("not_found") : created(toRow(rows[0]));
    },

    requestDestroy: async (input) => {
      if (
        typeof input.idempotencyKey !== "string" ||
        !CLIENT_KEY_PATTERN.test(input.idempotencyKey)
      ) {
        return refused("validation");
      }
      if (typeof input.resourceId !== "string" || !isUuid(input.resourceId)) {
        return refused("not_found");
      }
      const destroyKey = customerOperationKey(customerId, input.idempotencyKey);
      const snapshotKey = customerOperationKey(customerId, `${input.idempotencyKey}:snapshot`);

      // The row under lock: two clicks together queue one destroy.
      const locked = await tx.execute<{ status: string }>(sql`
        select s.status from subscriptions s
        join resources r on r.id = s.resource_id
        where s.resource_id = ${input.resourceId} and s.customer_id = ${customerId}
          and r.customer_id = ${customerId}
        for update of s`);
      const state = locked.rows[0]?.status;
      if (state === undefined) return refused("not_found");

      // A repeat of the same request: the operations are already there.
      const found = await tx.execute<{
        id: string;
        snapshotId: string | null;
        needsApproval: boolean;
      }>(sql`
        select o.id, o.needs_approval as "needsApproval",
          (select o2.id from operations o2 where o2.idempotency_key = ${snapshotKey}
             and o2.resource_id = o.resource_id) as "snapshotId"
        from operations o join resources r on r.id = o.resource_id
        where o.idempotency_key = ${destroyKey} and o.resource_id = ${input.resourceId}
          and r.customer_id = ${customerId} and o.kind = 'destroy'`);
      const existing = found.rows[0];
      if (existing !== undefined) {
        return replayed({
          destroyOperationId: existing.id,
          finalSnapshotOperationId: existing.snapshotId,
          needsApproval: existing.needsApproval,
        });
      }
      // WPU-X23 (R7): a destroy that is already live for this resource answers the request, whatever its
      // key (the customer's earlier click with another request id, or the one the lifecycle's ensure pass
      // queued for the retained subscription). Never a second row.
      const live = await liveDestroyOf(tx, input.resourceId, customerId);
      if (live !== null) {
        return replayed({
          destroyOperationId: live.operationId,
          finalSnapshotOperationId: null,
          needsApproval: live.needsApproval,
        });
      }
      // Only a paid-up or suspended subscription is destroyed by its owner; anything else is a
      // different state of the lifecycle and is refused (R16).
      if (state !== "active" && state !== "grace") return refused("conflict");

      const until = await readApprovalUntil(tx);
      const now = new Date();
      let snapshotId: string | null = null;
      if (input.withFinalSnapshot) {
        const v = operationInsertValues(
          {
            resourceId: input.resourceId,
            kind: "final_snapshot",
            payload: {},
            idempotencyKey: snapshotKey,
          },
          now,
          until,
        );
        await tx.execute(sql`
          insert into operations (id, resource_id, kind, state, idempotency_key, payload)
          select ${v.id}, r.id, ${v.kind}, ${v.state}, ${v.idempotencyKey}, ${v.payloadJson}::jsonb
          from resources r where r.id = ${v.resourceId} and r.customer_id = ${customerId}`);
        snapshotId = v.id;
      }
      const d = operationInsertValues(
        { resourceId: input.resourceId, kind: "destroy", payload: {}, idempotencyKey: destroyKey },
        now,
        until,
      );
      await tx.execute(sql`
        insert into operations (id, resource_id, kind, state, idempotency_key, payload, needs_approval)
        select ${d.id}, r.id, ${d.kind}, ${d.state}, ${d.idempotencyKey}, ${d.payloadJson}::jsonb, ${d.needsApproval}
        from resources r where r.id = ${d.resourceId} and r.customer_id = ${customerId}`);
      await tx.execute(sql`
        update subscriptions set status = 'retained'
        where resource_id = ${input.resourceId} and customer_id = ${customerId}`);
      // WPU-Y4: the disks attached to a server end with it, in this transaction, for this customer only (R8).
      await retainAttachedDisks(tx, { customerId, serverId: input.resourceId }, now);
      return created({
        destroyOperationId: d.id,
        finalSnapshotOperationId: snapshotId,
        needsApproval: d.needsApproval,
      });
    },
  };
}
