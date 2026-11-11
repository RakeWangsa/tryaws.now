// Operations that no worker moves (spec 10.1). Only a report: the operations engine owns retries, and
// nothing here changes a row. needs_approval is a human queue, not a stale job.

export interface OpRow {
  readonly id: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly nextRunAt: Date;
  readonly createdAt: Date;
}

export interface StaleOperation {
  readonly operationId: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly ageMs: number;
}

const STALE_AFTER_MS = 2 * 3_600_000;
const STALE_ATTENTION_AFTER_MS = 24 * 3_600_000;
const MOVING: readonly string[] = ["queued", "running", "waiting"];

export function staleOperations(rows: readonly OpRow[], now: Date): StaleOperation[] {
  const out: StaleOperation[] = [];
  for (const op of rows) {
    let ageMs: number;
    if (MOVING.includes(op.state)) {
      ageMs = now.getTime() - op.nextRunAt.getTime();
      if (ageMs < STALE_AFTER_MS) continue;
    } else if (op.state === "needs_attention") {
      ageMs = now.getTime() - op.createdAt.getTime();
      if (ageMs < STALE_ATTENTION_AFTER_MS) continue;
    } else continue;
    out.push({
      operationId: op.id,
      resourceId: op.resourceId,
      kind: op.kind,
      state: op.state,
      attempts: op.attempts,
      ageMs,
    });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs || a.operationId.localeCompare(b.operationId));
}
