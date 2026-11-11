import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import { isUuid } from "./scope";

// The statements of the backup and disk adapters (WP5-T1, WP5-T2), run as worker_rw by the
// provisioner. They take the customer id from the resource row the operation belongs to (R8), name
// only columns that worker_rw may read or write (grants.expected.json) and log nothing.
//
// R13 and the lifecycle guard: a final snapshot is a child `backup` resource with config.final =
// true, made by the adapter. The guard (resourceOfOperation) counts it only when it is `active` and
// was created at or after the latest final_snapshot operation of the parent.

/** The child backup rows of a parent that are not destroyed. */
export async function listBackupsOf(
  tx: Tx,
  input: { customerId: string; parentResourceId: string },
): Promise<{ id: string }[]> {
  if (!isUuid(input.customerId) || !isUuid(input.parentResourceId)) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    select id from resources
    where parent_resource_id = ${input.parentResourceId} and customer_id = ${input.customerId}
      and family = 'backup' and state <> 'destroyed'
    order by created_at, id`);
  return rows.map((r) => ({ id: r.id }));
}

/**
 * The child backup row of one final_snapshot operation: the first call inserts it as `creating`
 * (pool and Region copied from the parent), a later call of the same operation finds it (R7).
 * Throws when the parent is not the customer's row (R16).
 */
export async function ensureFinalBackup(
  tx: Tx,
  input: { customerId: string; parentResourceId: string; operationId: string },
): Promise<{ id: string }> {
  const { customerId, parentResourceId, operationId } = input;
  if (!isUuid(customerId) || !isUuid(parentResourceId) || !isUuid(operationId)) {
    throw new Error("final backup: invalid id");
  }
  const found = await tx.execute<{ id: string }>(sql`
    select id from resources
    where parent_resource_id = ${parentResourceId} and customer_id = ${customerId}
      and family = 'backup' and config ->> 'finalOperation' = ${operationId}
    limit 1`);
  const existing = found.rows[0];
  if (existing !== undefined) return { id: existing.id };
  const id = uuidv7();
  const config = JSON.stringify({ final: true, finalOperation: operationId });
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into resources (id, customer_id, family, pool_account_id, region, parent_resource_id, state, config)
    select ${id}, p.customer_id, 'backup', p.pool_account_id, p.region, p.id, 'creating', ${config}::jsonb
    from resources p
    where p.id = ${parentResourceId} and p.customer_id = ${customerId}
    returning id`);
  if (inserted.rows[0] === undefined) throw new Error("final backup: parent not found");
  return { id };
}

/** The snapshot is available: the row becomes `active` with its AWS name and size. */
export async function markFinalBackup(
  tx: Tx,
  input: { id: string; customerId: string; awsName: string; sizeGb: number | null },
): Promise<void> {
  if (!isUuid(input.id) || !isUuid(input.customerId)) throw new Error("final backup: invalid id");
  const merge = JSON.stringify(input.sizeGb === null ? {} : { sizeGb: input.sizeGb });
  const result = await tx.execute(sql`
    update resources
    set state = 'active', aws_name = coalesce(aws_name, ${input.awsName}), config = config || ${merge}::jsonb
    where id = ${input.id} and customer_id = ${input.customerId} and family = 'backup'
      and config ->> 'final' = 'true' and state in ('creating', 'active')`);
  if ((result.rowCount ?? 0) !== 1) throw new Error("final backup: not found");
}
