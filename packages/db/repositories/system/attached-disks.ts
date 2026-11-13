import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../../client";
import { insertFreshOperation, insertOperation } from "../../operations/insert";
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
 * WPU-Y4 fix round 2. The status a disk subscription had before the cascade retained it with its server: `active`
 * or `grace` (the cascade retained it, a revival of the server gives it back), or `retained` (it was retained on its
 * own; a revival of the server does not touch it).
 */
export type RetainedFrom = "active" | "grace" | "retained";

/** The mark `resources.config.retainedWithServer` of a disk retained with its server (worker_rw writes it). */
export const RETAINED_WITH_SERVER_KEY = "retainedWithServer";

const isFrom = (v: unknown): v is RetainedFrom =>
  v === "active" || v === "grace" || v === "retained";

/**
 * The disks attached to `serverId` that still live, under the lock of their subscriptions, retained with their
 * operations. Returns the operations (created or replayed) so the engine can send the queue messages after commit.
 * The payload of a new operation names the server (`withServer`) and the disk's status before (`from`).
 * `markConfig` (worker_rw only: web_rw may not update resources) also writes the mark `retainedWithServer =
 * { serverId, from }` on the disk, which the disk adapter and the guard read when the payload of a replayed
 * destroy (one the disk got on its own) has no `withServer`, and which a revival of the server reads to give the
 * disk its status back (releaseServerDisks of @tc/core).
 */
export async function retainAttachedDisks(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
  now: Date,
  options: { readonly markConfig?: boolean } = {},
): Promise<AttachedDiskOperation[]> {
  if (!isUuid(input.customerId)) throw new TypeError("attached disks: customer id is not a UUID");
  if (!isUuid(input.serverId)) throw new TypeError("attached disks: server id is not a UUID");
  // Fix round 3: web_rw may not read operations.payload (grants.expected.json), so the former status kept in an
  // earlier destroy's payload is read on the worker path (markConfig) only. The web path (the customer's own destroy)
  // reads the subscription's own status, which is all it needs: it runs once, before the disk is retained.
  const payloadFrom =
    options.markConfig === true
      ? sql`(select o.payload ->> 'from' from operations o
          where o.resource_id = r.id and o.kind = 'destroy'
            and o.state not in ('failed', 'succeeded')
            and o.payload ->> 'withServer' = ${input.serverId}
          order by o.created_at desc, o.id desc limit 1)`
      : sql`null::text`;
  const { rows } = await tx.execute<{
    disk_id: string;
    subscription_id: string;
    status: string;
    period_end: unknown;
    mark: unknown;
    payload_from: unknown;
  }>(sql`
    select r.id as disk_id, s.id as subscription_id, s.status, s.period_end,
      r.config -> 'retainedWithServer' as mark,
      ${payloadFrom} as payload_from
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
    const mark =
      typeof row.mark === "object" && row.mark !== null
        ? (row.mark as Record<string, unknown>)
        : null;
    const marked = mark !== null && mark["serverId"] === input.serverId && isFrom(mark["from"]);
    // What the disk was before: its own status now, or (already retained) what this cascade recorded before,
    // else it was retained on its own.
    const from: RetainedFrom =
      row.status === "active" || row.status === "grace"
        ? row.status
        : marked
          ? (mark["from"] as RetainedFrom)
          : isFrom(row.payload_from)
            ? row.payload_from
            : "retained";
    if (row.status !== "retained") {
      await tx.execute(sql`
        update subscriptions set status = 'retained'
        where id = ${row.subscription_id} and customer_id = ${input.customerId}`);
    }
    if (options.markConfig === true && !marked) {
      const value = JSON.stringify({
        [RETAINED_WITH_SERVER_KEY]: { serverId: input.serverId, from },
      });
      await tx.execute(sql`
        update resources set config = config || ${value}::jsonb
        where id = ${row.disk_id} and customer_id = ${input.customerId}`);
    }
    const periodEnd =
      row.period_end instanceof Date ? row.period_end : new Date(String(row.period_end));
    // Fix round 4: a disk retained NOW (it was active or in grace) gets live operations even when an earlier
    // retention of the same period ended under the same key (a release): insertFreshOperation moves past an
    // ended row. A disk already retained replays what exists.
    const insert = row.status === "retained" ? insertOperation : insertFreshOperation;
    for (const kind of ["final_snapshot", "destroy"] as const) {
      const inserted = await insert(
        tx,
        {
          resourceId: row.disk_id,
          kind,
          payload: { subscriptionId: row.subscription_id, withServer: input.serverId, from },
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

export interface DiskRetainedWithServer {
  readonly diskId: string;
  readonly subscriptionId: string;
  readonly status: string;
  /** The status before the cascade; `retained` = retained on its own (or unknown: fail closed, nothing given back). */
  readonly from: RetainedFrom;
}

/**
 * WPU-Y4 fix round 2 (worker_rw). The disks of this customer that the cascade retained with `serverId` (the mark on
 * the disk, or a destroy whose payload names the server), under the lock of their subscriptions. Fix round 4: only
 * a destroy that has not ended counts (a failed row of an earlier, released retention is history), and the payload
 * branch needs the disk to be attached to that server still.
 */
export async function listDisksRetainedWithServer(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
): Promise<DiskRetainedWithServer[]> {
  if (!isUuid(input.customerId)) throw new TypeError("attached disks: customer id is not a UUID");
  if (!isUuid(input.serverId)) throw new TypeError("attached disks: server id is not a UUID");
  const { rows } = await tx.execute<{
    disk_id: string;
    subscription_id: string;
    status: string;
    mark_server: unknown;
    mark_from: unknown;
    payload_from: unknown;
  }>(sql`
    select r.id as disk_id, s.id as subscription_id, s.status,
      r.config -> 'retainedWithServer' ->> 'serverId' as mark_server,
      r.config -> 'retainedWithServer' ->> 'from' as mark_from,
      (select o.payload ->> 'from' from operations o
        where o.resource_id = r.id and o.kind = 'destroy'
          and o.state not in ('failed', 'succeeded')
          and o.payload ->> 'withServer' = ${input.serverId}
        order by o.created_at desc, o.id desc limit 1) as payload_from
    from resources r
    join subscriptions s on s.resource_id = r.id
    where r.customer_id = ${input.customerId} and s.customer_id = ${input.customerId}
      and r.family = 'disk'
      and r.state not in ('destroyed', 'failed')
      and r.deleted_at is null
      and (r.config -> 'retainedWithServer' ->> 'serverId' = ${input.serverId}
        or (r.config ->> 'attachedInstanceId' = ${input.serverId}
          and exists (select 1 from operations o
            where o.resource_id = r.id and o.kind = 'destroy'
              and o.state not in ('failed', 'succeeded')
              and o.payload ->> 'withServer' = ${input.serverId})))
    order by r.id
    for update of s`);
  return rows.map((row) => ({
    diskId: row.disk_id,
    subscriptionId: row.subscription_id,
    status: row.status,
    from:
      row.mark_server === input.serverId && isFrom(row.mark_from)
        ? row.mark_from
        : isFrom(row.payload_from)
          ? row.payload_from
          : "retained",
  }));
}

/** WPU-Y4 fix round 2 (worker_rw). Removes the mark `retainedWithServer` of one disk of this customer. */
export async function clearRetainedWithServer(
  tx: Tx,
  input: { readonly customerId: string; readonly diskId: string },
): Promise<void> {
  if (!isUuid(input.customerId)) throw new TypeError("attached disks: customer id is not a UUID");
  if (!isUuid(input.diskId)) throw new TypeError("attached disks: disk id is not a UUID");
  await tx.execute(sql`
    update resources set config = config - 'retainedWithServer'
    where id = ${input.diskId} and customer_id = ${input.customerId} and family = 'disk'`);
}

/**
 * WPU-Y4 fix round 2 (the guard, R13). The subscription status of `serverId` when it is a server of the same
 * customer as the disk `diskId`; null otherwise (another customer's id, a missing row: the guard refuses).
 */
export async function serverStatusForDisk(
  tx: Tx,
  input: { readonly diskId: string; readonly serverId: string },
): Promise<string | null> {
  if (!isUuid(input.diskId) || !isUuid(input.serverId)) return null;
  const { rows } = await tx.execute<{ status: string }>(sql`
    select s.status from resources d
    join resources srv on srv.customer_id = d.customer_id
    join subscriptions s on s.resource_id = srv.id and s.customer_id = srv.customer_id
    where d.id = ${input.diskId} and srv.id = ${input.serverId}
      and srv.family in ('linux_instance', 'windows_instance')`);
  return rows[0]?.status ?? null;
}

/**
 * WPU-Y4 fix round 2 (point 2). The subscription status of the server a disk is attached to, when that server is
 * the customer's own; null when the disk is not attached to one of the customer's servers.
 */
export async function attachedServerStatus(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
): Promise<string | null> {
  if (!isUuid(input.customerId) || !isUuid(input.serverId)) return null;
  const { rows } = await tx.execute<{ status: string }>(sql`
    select s.status from resources srv
    join subscriptions s on s.resource_id = srv.id and s.customer_id = srv.customer_id
    where srv.id = ${input.serverId} and srv.customer_id = ${input.customerId}
      and srv.family in ('linux_instance', 'windows_instance')`);
  return rows[0]?.status ?? null;
}

/**
 * WPU-Y4 fix round 4 (worker_rw). An attention item for operations: a disk retained with its server could not be
 * given back when the server was revived, because its destroy may already have sent DeleteDisk. Ids and fixed words
 * only (R14). It shows in the discrepancies list of the admin app.
 */
export async function recordDiskHeld(
  tx: Tx,
  input: { readonly diskId: string; readonly serverId: string },
): Promise<void> {
  if (!isUuid(input.diskId) || !isUuid(input.serverId)) {
    throw new TypeError("attached disks: id is not a UUID");
  }
  const details = JSON.stringify({
    resourceId: input.diskId,
    serverId: input.serverId,
    reason: "disk_destroy_may_have_run",
    source: "attached_disks",
  });
  await tx.execute(sql`insert into discrepancies (id, kind, details)
    values (${uuidv7()}, 'missing', ${details}::jsonb)`);
}

export interface DiskRetentionOp {
  readonly id: string;
  readonly kind: "destroy" | "final_snapshot";
  readonly state: string;
  readonly step: string | null;
  /** WPU-X1: how often the provisioner claimed it (a final snapshot that was attempted has started). */
  readonly attempts: number;
}

/**
 * WPU-Y4 fix round 5 (worker_rw). The destroy and final_snapshot rows of one disk, locked FOR UPDATE: the
 * provisioner's claim locks the operation row too (loadRunView), so a release and a claim of the DeleteDisk step
 * never interleave; what is read here is what the release decides on.
 */
export async function lockDiskRetentionOps(tx: Tx, diskId: string): Promise<DiskRetentionOp[]> {
  if (!isUuid(diskId)) throw new TypeError("attached disks: disk id is not a UUID");
  const { rows } = await tx.execute<{
    id: string;
    kind: string;
    state: string;
    step: string | null;
    attempts: number;
  }>(
    sql`select id, kind, state, step, attempts from operations
      where resource_id = ${diskId} and kind in ('destroy', 'final_snapshot')
      order by created_at, id
      for update`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as DiskRetentionOp["kind"],
    state: r.state,
    step: r.step ?? null,
    attempts: Number(r.attempts),
  }));
}

/**
 * WPU-Y4 fix round 5 (worker_rw). The system end of the given operations of a disk whose server was revived: each
 * that is not running and has not ended becomes `failed` (approved or not; `failed` is allowed by every check of the
 * operations table), so a later retention of the disk gets fresh rows (insertFreshOperation). WPU-X1: returns the
 * ids of the rows it ended (the caller logs them).
 */
export async function endDiskRetentionOps(
  tx: Tx,
  input: { readonly diskId: string; readonly operationIds: readonly string[] },
): Promise<string[]> {
  if (!isUuid(input.diskId)) throw new TypeError("attached disks: disk id is not a UUID");
  const ids = input.operationIds.filter((id) => isUuid(id));
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    update operations set state = 'failed', last_error = 'cancelled: the server was revived'
    where resource_id = ${input.diskId}
      and id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      and kind in ('destroy', 'final_snapshot')
      and state not in ('running', 'succeeded', 'failed')
    returning id`);
  return rows.map((r) => r.id);
}
