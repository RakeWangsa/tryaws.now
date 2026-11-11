import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import { isUuid } from "../repositories/scope";
import { readApprovalUntil } from "./approval";
import { isOperationKind, requiresApproval, type OperationKind } from "./kinds";
import type { OperationState } from "./kinds";

// The largest serialized payload. A payload holds ids and plain options only (R11).
export const MAX_PAYLOAD_BYTES = 16_384;

// The input of enqueueOperation of F.
export interface OperationInput {
  readonly resourceId: string;
  readonly kind: OperationKind;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  // D21: the fixed table kind -> approval decides. A caller can only raise the gate with true.
  // false and undefined mean "no more than the table asks".
  readonly needsApproval?: boolean;
}

export interface OperationInsertValues {
  readonly id: string;
  readonly resourceId: string;
  readonly kind: OperationKind;
  readonly state: "queued" | "needs_approval";
  readonly needsApproval: boolean;
  readonly payloadJson: string;
  readonly idempotencyKey: string;
}

const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
// The key space of operations.request (WP1-T2 open point 7).
const CUSTOMER_KEY_PREFIX = "customer:";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// jsonb refuses U+0000 (22P05) and a lone surrogate (22P02), and JSON.stringify accepts both.
function hasUnstorableText(value: unknown): boolean {
  // \p{Cs} with the u flag matches only an unpaired surrogate (the lib of this repo has no
  // String.prototype.isWellFormed).
  if (typeof value === "string") return value.includes("\u0000") || /\p{Cs}/u.test(value);
  if (Array.isArray(value)) return value.some(hasUnstorableText);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, v]) => hasUnstorableText(key) || hasUnstorableText(v));
  }
  return false;
}

function serializePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return "{}";
  if (!isPlainObject(payload)) throw new RangeError("operation: the payload is not an object");
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new RangeError("operation: the payload cannot be serialized");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new RangeError("operation: the payload is too large");
  }
  // The text that was stored is the text that is checked (a toJSON hook cannot hide a value).
  if (hasUnstorableText(JSON.parse(json))) {
    throw new RangeError("operation: the payload holds text that cannot be stored");
  }
  return json;
}

// The one function of defaults for every insert path. Pure. `until` is the end date of R13, read
// with readApprovalUntil. Every message is fixed text: it never holds a refused value (R14).
export function operationInsertValues(
  input: OperationInput,
  at: Date,
  until: Date | null,
): OperationInsertValues {
  if (typeof input.resourceId !== "string" || !isUuid(input.resourceId)) {
    throw new RangeError("operation: the resource id is not a UUID");
  }
  if (!isOperationKind(input.kind)) throw new RangeError("operation: unknown kind");
  if (typeof input.idempotencyKey !== "string" || !KEY_PATTERN.test(input.idempotencyKey)) {
    throw new RangeError("operation: the idempotency key is not valid");
  }
  const payloadJson = serializePayload(input.payload);
  // D21: the flag is the table (or the caller raising it); it is never lowered.
  const needsApproval = input.needsApproval === true || requiresApproval(input.kind, at, until);
  return {
    id: uuidv7(),
    resourceId: input.resourceId,
    kind: input.kind,
    state: needsApproval ? "needs_approval" : "queued",
    needsApproval,
    payloadJson,
    idempotencyKey: input.idempotencyKey,
  };
}

export interface InsertedOperation {
  readonly operationId: string;
  readonly created: boolean;
  readonly state: OperationState;
  readonly enqueueSeq: number;
}

export class OperationKeyConflict extends Error {
  constructor() {
    super("operation: the idempotency key belongs to another operation");
    this.name = "OperationKeyConflict";
  }
}

type StoredOperation = {
  operationId: string;
  resourceId: string;
  kind: string;
  state: OperationState;
  enqueueSeq: number;
};

// For system code only: the purchase, the lifecycle, the scheduler and the admin statements. A
// customer request uses operations.request. The statements name only columns that web_rw, worker_rw
// and admin_rw may write or read: no next_run_at and no created_at (the database default is now()),
// and needs_approval only when it is true, so admin_rw can insert an unflagged operation and a
// flagged one fails with 42501 (R16).
export async function insertOperation(
  tx: Tx,
  input: OperationInput,
  at: Date,
): Promise<InsertedOperation> {
  if (
    typeof input.idempotencyKey === "string" &&
    input.idempotencyKey.startsWith(CUSTOMER_KEY_PREFIX)
  ) {
    throw new RangeError("operation: this key space belongs to the customer request");
  }
  const until = await readApprovalUntil(tx);
  const v = operationInsertValues(input, at, until);

  const inserted = v.needsApproval
    ? await tx.execute<Omit<StoredOperation, "resourceId" | "kind">>(sql`
        insert into operations as o (id, resource_id, kind, state, idempotency_key, payload, needs_approval)
        values (${v.id}, ${v.resourceId}, ${v.kind}, ${v.state}, ${v.idempotencyKey}, ${v.payloadJson}::jsonb, true)
        on conflict (idempotency_key) do nothing
        returning o.id as "operationId", o.state as "state", o.enqueue_seq as "enqueueSeq"`)
    : await tx.execute<Omit<StoredOperation, "resourceId" | "kind">>(sql`
        insert into operations as o (id, resource_id, kind, state, idempotency_key, payload)
        values (${v.id}, ${v.resourceId}, ${v.kind}, ${v.state}, ${v.idempotencyKey}, ${v.payloadJson}::jsonb)
        on conflict (idempotency_key) do nothing
        returning o.id as "operationId", o.state as "state", o.enqueue_seq as "enqueueSeq"`);
  const [row] = inserted.rows;
  if (row !== undefined) {
    return {
      operationId: row.operationId,
      created: true,
      state: row.state,
      enqueueSeq: row.enqueueSeq,
    };
  }

  // The key is taken. The payload and the flag are not compared (open points 4 and 5): a replay
  // answers with the stored row. Another resource or kind is a different request.
  const found = await tx.execute<StoredOperation>(sql`
    select o.id as "operationId", o.resource_id as "resourceId", o.kind as "kind",
      o.state as "state", o.enqueue_seq as "enqueueSeq"
    from operations o where o.idempotency_key = ${v.idempotencyKey}`);
  const [stored] = found.rows;
  if (
    stored === undefined ||
    stored.resourceId.toLowerCase() !== v.resourceId.toLowerCase() ||
    stored.kind !== v.kind
  ) {
    throw new OperationKeyConflict();
  }
  return {
    operationId: stored.operationId,
    created: false,
    state: stored.state,
    enqueueSeq: stored.enqueueSeq,
  };
}
