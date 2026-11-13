import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { insertOperation } from "../../operations/insert";
import type { OperationState } from "../../operations/kinds";
import { isUuid } from "../scope";

// WPU-Y4 (owner decision 2026-11-14: "if server destroyed then the disk also needs to be deleted"). When a server's
// subscription becomes `retained` (the end of its grace, the unpaid rule or the customer's own destroy), every disk
// attached to it (resources.config.attachedInstanceId = the server) ends with it: its own subscription becomes
// `retained` in the same transaction (so it is never renewed or charged again; nothing is posted to the ledger, R5),
// and its final snapshot and destroy are queued (R13: the guard checks the state and the snapshot when each is
// claimed; the destroy waits for an admin until the end date of R13, decided by insertOperation). The payload names
// the server (`withServer`): the disk adapter then waits for the server's own destroy to stop it before it detaches.
//
// The keys are the lifecycle engine's own (lifecycleOperationKey with the disk's subscription and period end), so
// the engine's `ensure_retention_operations` pass for the disk replays these rows and never adds a second destroy
// (R7). Every statement filters by the customer id of the caller: the session's customer for the customer's
// destroy (R8), the subscription's customer for the engine.

/** The key of an operation of the lifecycle: one per subscription, kind and period (R7). */
export function lifecycleOperationKey(kind: string, subscriptionId: string, at: Date): string {
  return `lifecycle:${kind.replaceAll("_", "-")}:${subscriptionId}:${at.toISOString()}`;
}

export interface AttachedDiskOperation {
  readonly diskId: string;
  readonly kind: "final_snapshot" | "destroy";
  readonly operationId: string;
  readonly created: boolean;
  readonly state: OperationState;
}

// Disk subscriptions in these states end with the server. `retained` is replayed (the rows exist or are added
// again under the same keys); `ended` has nothing left to do.
const ENDS_WITH_SERVER = new Set(["active", "grace", "retained"]);

/**
 * The disks attached to `serverId` that still live, under the lock of their subscriptions, retained with their
 * operations. Returns the operations (created or replayed) so the engine can send the queue messages after commit.
 */
export async function retainAttachedDisks(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
  now: Date,
): Promise<AttachedDiskOperation[]> {
  if (!isUuid(input.customerId)) throw new TypeError("attached disks: customer id is not a UUID");
  if (!isUuid(input.serverId)) throw new TypeError("attached disks: server id is not a UUID");
  const { rows } = await tx.execute<{
    disk_id: string;
    subscription_id: string;
    status: string;
    period_end: unknown;
  }>(sql`
    select r.id as disk_id, s.id as subscription_id, s.status, s.period_end
    from resources r
    join subscriptions s on s.resource_id = r.id
    where r.customer_id = ${input.customerId} and s.customer_id = ${input.customerId}
      and r.family = 'disk'
      and r.config->>'attachedInstanceId' = ${input.serverId}
      and r.state not in ('destroyed', 'failed')
      and r.deleted_at is null
    order by r.id
    for update of s`);

  const out: AttachedDiskOperation[] = [];
  for (const row of rows) {
    if (!ENDS_WITH_SERVER.has(row.status)) continue;
    if (row.status !== "retained") {
      await tx.execute(sql`
        update subscriptions set status = 'retained'
        where id = ${row.subscription_id} and customer_id = ${input.customerId}`);
    }
    const periodEnd =
      row.period_end instanceof Date ? row.period_end : new Date(String(row.period_end));
    for (const kind of ["final_snapshot", "destroy"] as const) {
      const inserted = await insertOperation(
        tx,
        {
          resourceId: row.disk_id,
          kind,
          payload: { subscriptionId: row.subscription_id, withServer: input.serverId },
          idempotencyKey: lifecycleOperationKey(kind, row.subscription_id, periodEnd),
        },
        now,
      );
      out.push({
        diskId: row.disk_id,
        kind,
        operationId: inserted.operationId,
        created: inserted.created,
        state: inserted.state,
      });
    }
  }
  return out;
}
