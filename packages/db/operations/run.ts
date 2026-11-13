import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { isUuid } from "../repositories/scope";
import { orders } from "../schema/money";
import { operations, poolAccounts, resources, type RESOURCE_STATES } from "../schema/provisioning";
import { SIBLING_BLOCKING_STATES, type OperationState } from "./kinds";

// The statements the provisioner and the scheduler run as worker_rw. They check no legality of a
// move (transitionOperation of @tc/core does) and they log nothing.

export type OperationRow = Omit<typeof operations.$inferSelect, "state"> & {
  readonly state: OperationState;
};
export type ResourceRow = typeof resources.$inferSelect;
// Only the columns of pool_accounts that worker_rw may read.
export interface PoolRow {
  readonly id: string;
  readonly awsAccountId: string;
  readonly externalId: string;
  readonly status: string;
}

export interface RunView {
  readonly operation: OperationRow;
  readonly resource: ResourceRow | null;
  readonly pool: PoolRow | null;
  readonly owner: {
    readonly orderCustomerId: string | null;
    readonly keyCustomerId: string | null;
  };
  readonly blockedBy: string | null;
}

const KEY_CUSTOMER = /^customer:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;

function keyCustomerId(key: string): string | null {
  return KEY_CUSTOMER.exec(key)?.[1]?.toLowerCase() ?? null;
}

async function orderCustomerId(tx: Tx, operation: OperationRow): Promise<string | null> {
  if (operation.kind !== "create") return null;
  const payload: unknown = operation.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const orderId = (payload as Record<string, unknown>)["orderId"];
  if (typeof orderId !== "string" || !isUuid(orderId)) return null;
  const rows = await tx
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return rows[0]?.customerId ?? null;
}

// A running operation of the resource comes first (of any age: an older operation that an admin
// retried must not start beside a younger one that is already running); then the oldest queued or
// waiting operation that is older than this one by (created_at, id).
async function blockingOperation(
  tx: Tx,
  operationId: string,
  resourceId: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    select o2.id as "id"
    from operations o2
    where o2.resource_id = ${resourceId} and o2.id <> ${operationId}
      and (o2.state = 'running'
        or (o2.state in ${SIBLING_BLOCKING_STATES} and o2.state <> 'running'
          and (o2.created_at, o2.id) < (select o3.created_at, o3.id from operations o3 where o3.id = ${operationId})))
    order by (o2.state = 'running') desc, o2.created_at, o2.id
    limit 1`);
  return rows[0]?.id ?? null;
}

// null for an id that is not a UUID (no query) and for an unknown id. The operation row stays
// locked (FOR UPDATE) until the transaction ends.
export async function loadRunView(tx: Tx, operationId: string): Promise<RunView | null> {
  if (!isUuid(operationId)) return null;
  const found = await tx
    .select()
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1)
    .for("update");
  const row = found[0];
  if (row === undefined) return null;
  const operation = row as OperationRow;

  const resourceRows = await tx
    .select()
    .from(resources)
    .where(eq(resources.id, operation.resourceId))
    .limit(1);
  const resource = resourceRows[0] ?? null;

  let pool: PoolRow | null = null;
  if (resource?.poolAccountId) {
    const poolRows = await tx
      .select({
        id: poolAccounts.id,
        awsAccountId: poolAccounts.awsAccountId,
        externalId: poolAccounts.externalId,
        status: poolAccounts.status,
      })
      .from(poolAccounts)
      .where(eq(poolAccounts.id, resource.poolAccountId))
      .limit(1);
    pool = poolRows[0] ?? null;
  }

  return {
    operation,
    resource,
    pool,
    owner: {
      orderCustomerId: await orderCustomerId(tx, operation),
      keyCustomerId: keyCustomerId(operation.idempotencyKey),
    },
    blockedBy: await blockingOperation(tx, operation.id, operation.resourceId),
  };
}

export interface OperationBrief {
  readonly id: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly state: OperationState;
  // WPU-Z13: a domain renewal at step `poll` is held by the registry; its rejection is refused (reject.ts).
  readonly step: string | null;
  // WPU-Y5 (c): a dns_zone create at `create_zone` may hold a zone once an attempt may have sent CreateHostedZone.
  readonly attempts: number;
  /** WPU-Y2: the last error (a renewal at poll carries its registry check and the time of it there). */
  readonly lastError: string | null;
  /** WPU-X3 (b): the payload of the target (a renewal's pre-renewal expiry, read by confirm_unrenewed). */
  readonly payload: unknown;
}

// The target of a reject_operation. The row stays locked until the transaction ends.
export async function loadOperationBrief(
  tx: Tx,
  operationId: string,
): Promise<OperationBrief | null> {
  if (!isUuid(operationId)) return null;
  const rows = await tx
    .select({
      id: operations.id,
      resourceId: operations.resourceId,
      kind: operations.kind,
      state: operations.state,
      step: operations.step,
      attempts: operations.attempts,
      lastError: operations.lastError,
      payload: operations.payload,
    })
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1)
    .for("update");
  const row = rows[0];
  return row === undefined ? null : { ...row, state: row.state as OperationState };
}

// R8: the owner is part of the same statement. Another customer's resource, a missing one and an id
// that is not a UUID all give null.
export async function loadOwnedResource(
  tx: Tx,
  customerId: string,
  resourceId: string,
): Promise<ResourceRow | null> {
  if (!isUuid(resourceId) || !isUuid(customerId)) return null;
  const rows = await tx
    .select()
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.customerId, customerId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface OperationUpdate {
  readonly id: string;
  readonly from: OperationState;
  // The next_run_at that the caller read; a record under another value changes nothing.
  readonly fence?: Date;
  readonly to: OperationState;
  readonly step?: string | null;
  readonly attempts?: number;
  readonly nextRunAt?: Date;
  readonly lastError?: string | null;
  readonly bumpEnqueueSeq?: boolean;
}

export type UpdateResult =
  { readonly applied: true; readonly enqueueSeq: number } | { readonly applied: false };

// One UPDATE under the fence (id, state, next_run_at). A field that is undefined is left alone; null
// for step or lastError writes NULL. Only columns that worker_rw may update.
export async function updateOperation(tx: Tx, update: OperationUpdate): Promise<UpdateResult> {
  const set: Partial<typeof operations.$inferInsert> = { state: update.to };
  if (update.step !== undefined) set.step = update.step;
  if (update.attempts !== undefined) set.attempts = update.attempts;
  if (update.nextRunAt !== undefined) set.nextRunAt = update.nextRunAt;
  if (update.lastError !== undefined) set.lastError = update.lastError;
  if (update.bumpEnqueueSeq === true) {
    set.enqueueSeq = sql`${operations.enqueueSeq} + 1` as unknown as number;
  }
  const rows = await tx
    .update(operations)
    .set(set)
    .where(
      and(
        eq(operations.id, update.id),
        eq(operations.state, update.from),
        update.fence === undefined ? undefined : eq(operations.nextRunAt, update.fence),
      ),
    )
    .returning({ enqueueSeq: operations.enqueueSeq });
  const row = rows[0];
  return row === undefined ? { applied: false } : { applied: true, enqueueSeq: row.enqueueSeq };
}

export interface ResourcePatchInput {
  readonly state?: (typeof RESOURCE_STATES)[number];
  readonly awsName?: string;
  readonly configMerge?: Readonly<Record<string, unknown>>;
  readonly deletedAt?: Date;
}

// One UPDATE: the state, deleted_at, aws_name = coalesce(aws_name, name) and a top-level merge of
// the config. A name that differs from the stored one is refused. An empty patch sends no query.
export async function patchResource(
  tx: Tx,
  resourceId: string,
  patch: ResourcePatchInput,
): Promise<void> {
  const set: Partial<typeof resources.$inferInsert> = {};
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.deletedAt !== undefined) set.deletedAt = patch.deletedAt;
  if (patch.awsName !== undefined) {
    set.awsName = sql`coalesce(${resources.awsName}, ${patch.awsName})` as unknown as string;
  }
  if (patch.configMerge !== undefined) {
    set.config = sql`${resources.config} || ${JSON.stringify(patch.configMerge)}::jsonb`;
  }
  if (Object.keys(set).length === 0) return;

  const rows = await tx
    .update(resources)
    .set(set)
    .where(
      and(
        eq(resources.id, resourceId),
        patch.awsName === undefined
          ? undefined
          : or(isNull(resources.awsName), eq(resources.awsName, patch.awsName)),
      ),
    )
    .returning({ id: resources.id });
  if (rows.length > 0) return;

  // No row changed: the name differs from the stored one, or the resource does not exist (R16).
  if (patch.awsName !== undefined) {
    const stored = await tx
      .select({ awsName: resources.awsName })
      .from(resources)
      .where(eq(resources.id, resourceId))
      .limit(1);
    if (stored[0] !== undefined) {
      throw new Error("resource: the aws name differs from the stored one");
    }
  }
  throw new Error("resource: not found");
}

export interface DueOperation {
  readonly id: string;
  readonly resourceId: string;
  readonly state: "queued" | "waiting" | "running";
  readonly kind: string;
  readonly attempts: number;
  readonly enqueueSeq: number;
}

// waiting and due, queued and still unsent staleQueuedSeconds after next_run_at, or running with an
// expired lease. Oldest first. FOR UPDATE SKIP LOCKED: a row that another transaction holds is
// skipped.
export async function selectDue(
  tx: Tx,
  now: Date,
  staleQueuedSeconds: number,
  limit: number,
): Promise<DueOperation[]> {
  const staleBefore = new Date(now.getTime() - staleQueuedSeconds * 1000);
  const rows = await tx
    .select({
      id: operations.id,
      resourceId: operations.resourceId,
      state: operations.state,
      kind: operations.kind,
      attempts: operations.attempts,
      enqueueSeq: operations.enqueueSeq,
    })
    .from(operations)
    .where(
      or(
        and(eq(operations.state, "waiting"), lte(operations.nextRunAt, now)),
        and(eq(operations.state, "queued"), lte(operations.nextRunAt, staleBefore)),
        and(eq(operations.state, "running"), lte(operations.nextRunAt, now)),
      ),
    )
    .orderBy(asc(operations.nextRunAt), asc(operations.id))
    .limit(limit)
    .for("update", { skipLocked: true });
  return rows as DueOperation[];
}
