import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import { isUuid } from "../repositories/scope";
import { operations } from "../schema/provisioning";
import { insertOperation } from "./insert";

// The database part of the decisions of an admin (16.12): approve, retry and reject. They run as
// admin_rw, write no audit row and send no message: the admin repository of WP8-T5 wraps them in
// `audited` (R10) and the Server Action sends the message after the commit. They are not exported
// from the @tc/db barrel: a barrel export would let a caller skip `audited`.

// What the caller sends to the queue after the commit.
export interface AdminMessage {
  readonly operationId: string;
  readonly resourceId: string;
  readonly enqueueSeq: number;
}

export type AdminOutcome =
  | { readonly ok: true; readonly replayed: boolean; readonly message: AdminMessage | null }
  | { readonly ok: false; readonly error: "not_found" | "conflict" | "forbidden" };

const NOT_FOUND: AdminOutcome = { ok: false, error: "not_found" };
const CONFLICT: AdminOutcome = { ok: false, error: "conflict" };
const FORBIDDEN: AdminOutcome = { ok: false, error: "forbidden" };

function accepted(
  replayed: boolean,
  operationId: string,
  resourceId: string,
  enqueueSeq: number,
): AdminOutcome {
  return { ok: true, replayed, message: { operationId, resourceId, enqueueSeq } };
}

async function readOperation(tx: Tx, operationId: string) {
  const rows = await tx
    .select({
      id: operations.id,
      resourceId: operations.resourceId,
      kind: operations.kind,
      state: operations.state,
      approvedBy: operations.approvedBy,
      enqueueSeq: operations.enqueueSeq,
    })
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1);
  return rows[0];
}

export async function approveOperation(
  tx: Tx,
  input: { operationId: string; adminId: string; at: Date },
): Promise<AdminOutcome> {
  if (typeof input.adminId !== "string" || !isUuid(input.adminId)) {
    throw new RangeError("operation: admin id is not a UUID");
  }
  if (typeof input.operationId !== "string" || !isUuid(input.operationId)) return NOT_FOUND;

  // The admin must be active: the check lies in the same statement as the write (R16).
  const updated = await tx
    .update(operations)
    .set({
      state: "queued",
      approvedBy: input.adminId,
      nextRunAt: input.at,
      enqueueSeq: sql`${operations.enqueueSeq} + 1`,
    })
    .where(
      and(
        eq(operations.id, input.operationId),
        eq(operations.state, "needs_approval"),
        sql`exists (select 1 from admin_users a where a.id = ${input.adminId} and a.status = 'active')`,
      ),
    )
    .returning({ resourceId: operations.resourceId, enqueueSeq: operations.enqueueSeq });
  const [won] = updated;
  if (won !== undefined) return accepted(false, input.operationId, won.resourceId, won.enqueueSeq);

  const found = await readOperation(tx, input.operationId);
  if (found === undefined) return NOT_FOUND;
  // Already approved, by anyone: the answer is the same, and the counter is the current one.
  if (found.approvedBy !== null) {
    return accepted(true, found.id, found.resourceId, found.enqueueSeq);
  }
  // Still waiting: the admin was the problem (unknown, disabled or not active).
  if (found.state === "needs_approval") return FORBIDDEN;
  return CONFLICT;
}

export async function retryOperation(
  tx: Tx,
  input: { operationId: string; at: Date },
): Promise<AdminOutcome> {
  if (typeof input.operationId !== "string" || !isUuid(input.operationId)) return NOT_FOUND;

  // attempts and last_error stay: admin_rw may not write them.
  const updated = await tx
    .update(operations)
    .set({
      state: "queued",
      nextRunAt: input.at,
      enqueueSeq: sql`${operations.enqueueSeq} + 1`,
    })
    .where(and(eq(operations.id, input.operationId), eq(operations.state, "needs_attention")))
    .returning({ resourceId: operations.resourceId, enqueueSeq: operations.enqueueSeq });
  const [won] = updated;
  if (won !== undefined) return accepted(false, input.operationId, won.resourceId, won.enqueueSeq);

  const found = await readOperation(tx, input.operationId);
  if (found === undefined) return NOT_FOUND;
  if (found.state === "queued") {
    return accepted(true, found.id, found.resourceId, found.enqueueSeq);
  }
  // failed is final: a retry is refused for it. Anything else is not a stuck operation.
  return CONFLICT;
}

export async function rejectOperation(
  tx: Tx,
  input: { operationId: string; at: Date },
): Promise<AdminOutcome> {
  if (typeof input.operationId !== "string" || !isUuid(input.operationId)) return NOT_FOUND;

  const target = await readOperation(tx, input.operationId);
  if (target === undefined) return NOT_FOUND;
  if (target.state === "failed") return { ok: true, replayed: true, message: null };

  if (target.state === "needs_approval") {
    // A paid create is rejected through the compensation path, not here (open point 14).
    if (target.kind === "create") return CONFLICT;
    const updated = await tx
      .update(operations)
      .set({ state: "failed" })
      .where(and(eq(operations.id, target.id), eq(operations.state, "needs_approval")))
      .returning({ id: operations.id });
    // No row: another admin was faster.
    if (updated.length !== 1) return CONFLICT;
    await noteRejectedRetention(tx, target);
    return { ok: true, replayed: false, message: null };
  }

  if (target.state === "needs_attention") {
    // Not `failed` here: that would skip the reversal of 10.1. The provisioner moves the target to
    // failed with the compensation hook when it runs the reject_operation.
    const inserted = await insertOperation(
      tx,
      {
        resourceId: target.resourceId,
        kind: "reject_operation",
        payload: { targetOperationId: target.id },
        idempotencyKey: "reject:" + target.id,
      },
      input.at,
    );
    // A repeat of the same reject is a replay: the attention item is written once.
    if (inserted.created) await noteRejectedRetention(tx, target);
    return accepted(
      !inserted.created,
      inserted.operationId,
      target.resourceId,
      inserted.enqueueSeq,
    );
  }

  return CONFLICT;
}

// WPU-X3 (b). The idempotency key of a "registry confirmed not renewed": the target and the id of the form, so the
// same form again is a replay (R7) and a later form (after a check that kept the renewal) is a new check.
export const CONFIRM_UNRENEWED_KEY = "admin:confirm-unrenewed:";

/**
 * WPU-X3 (b). The admin's "registry confirmed not renewed" of a domain renewal stuck in needs_attention at `poll`:
 * inserts a `confirm_unrenewed` that the provisioner runs (a fresh registry check; the refund only on a final "not
 * renewed" with the expiry unchanged). The admin never moves the target and never calls AWS (R1). A replay of the same
 * form answers the first operation even when the target moved since; a new form needs the target still stuck at poll.
 */
export async function confirmUnrenewedOperation(
  tx: Tx,
  input: { operationId: string; requestId: string; at: Date },
): Promise<AdminOutcome> {
  if (typeof input.operationId !== "string" || !isUuid(input.operationId)) return NOT_FOUND;
  if (typeof input.requestId !== "string" || !isUuid(input.requestId)) return CONFLICT;
  const targetId = input.operationId.toLowerCase();
  const key = `${CONFIRM_UNRENEWED_KEY}${targetId}:${input.requestId.toLowerCase()}`;
  const known = await tx
    .select({
      id: operations.id,
      resourceId: operations.resourceId,
      enqueueSeq: operations.enqueueSeq,
    })
    .from(operations)
    .where(eq(operations.idempotencyKey, key))
    .limit(1);
  const prior = known[0];
  if (prior !== undefined) return accepted(true, prior.id, prior.resourceId, prior.enqueueSeq);

  const rows = await tx
    .select({
      id: operations.id,
      resourceId: operations.resourceId,
      kind: operations.kind,
      state: operations.state,
      step: operations.step,
    })
    .from(operations)
    .where(eq(operations.id, targetId))
    .limit(1);
  const target = rows[0];
  if (target === undefined) return NOT_FOUND;
  if (
    target.kind !== "renew_domain" ||
    target.state !== "needs_attention" ||
    target.step !== "poll"
  ) {
    return CONFLICT;
  }
  const inserted = await insertOperation(
    tx,
    {
      resourceId: target.resourceId,
      kind: "confirm_unrenewed",
      payload: { targetOperationId: target.id, requestId: input.requestId.toLowerCase() },
      idempotencyKey: key,
    },
    input.at,
  );
  return accepted(!inserted.created, inserted.operationId, target.resourceId, inserted.enqueueSeq);
}

/**
 * WPU-Y4 fix round 5 (M2). An admin's reject of a destroy whose subscription is `retained` and whose resource still
 * lives leaves the subscription retained with no live destroy: no renewal, no charge, no deletion. That is TiCON's
 * cost until someone acts, so an attention item is written in the same transaction (admin_rw may insert
 * discrepancies). Ids and fixed words only (R14). A repeat of the reject is a replay above and writes nothing more.
 */
async function noteRejectedRetention(
  tx: Tx,
  target: { readonly id: string; readonly kind: string; readonly resourceId: string },
): Promise<void> {
  if (target.kind !== "destroy") return;
  const { rows } = await tx.execute<{ status: string }>(sql`
    select s.status from subscriptions s join resources r on r.id = s.resource_id
    where r.id = ${target.resourceId} and r.state not in ('destroyed', 'failed') and r.deleted_at is null`);
  if (rows[0]?.status !== "retained") return;
  const details = JSON.stringify({
    resourceId: target.resourceId,
    operationId: target.id,
    reason: "retention_destroy_rejected",
    source: "admin_reject",
  });
  await tx.execute(sql`insert into discrepancies (id, kind, details)
    values (${uuidv7()}, 'missing', ${details}::jsonb)`);
}
