import { and, eq, sql } from "drizzle-orm";
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
    return updated.length === 1 ? { ok: true, replayed: false, message: null } : CONFLICT;
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
    return accepted(
      !inserted.created,
      inserted.operationId,
      target.resourceId,
      inserted.enqueueSeq,
    );
  }

  return CONFLICT;
}
