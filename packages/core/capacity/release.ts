import {
  capacityReleaseRepo,
  capacityRepo,
  isReservedCell,
  ROLLING_WINDOW_CODES,
  type CapacityCellRow,
  type ReservedCell,
  type Tx,
  type UsedChange,
} from "@tc/db";
import type { Clock, Result } from "../types";

const MAX_RECORD_CELLS = 20;

// Pure. Lowers used by the reserved amount and clamps at zero (a cell that was lowered by the
// hourly floor goes to `clamped`). A certificate of the last 365 days gives nothing back. A cell
// with no row goes to `missing`.
export function planRelease(
  rows: readonly CapacityCellRow[],
  cells: readonly ReservedCell[],
): { changes: UsedChange[]; clamped: ReservedCell[]; missing: ReservedCell[] } {
  const changes: UsedChange[] = [];
  const clamped: ReservedCell[] = [];
  const missing: ReservedCell[] = [];
  for (const cell of cells) {
    const row = rows.find((r) => r.quotaCode === cell.quotaCode && r.region === cell.region);
    if (!row) {
      missing.push(cell);
      continue;
    }
    if (ROLLING_WINDOW_CODES.includes(cell.quotaCode)) continue;
    if (row.used < cell.amount) clamped.push(cell);
    changes.push({
      rowId: row.rowId,
      used: Math.max(0, row.used - cell.amount),
      expectedUsed: row.used,
    });
  }
  return { changes, clamped, missing };
}

export type ReleaseOutcome =
  | { released: true; cells: ReservedCell[]; clamped: ReservedCell[] }
  | {
      released: false;
      reason:
        "no_reservation" | "already_released" | "not_final" | "malformed_record" | "row_missing";
    };

function readRecord(
  record: unknown,
  poolAccountId: string | null,
): { poolAccountId: string; cells: ReservedCell[] } | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const rec = record as Record<string, unknown>;
  if (rec.v !== 1 || poolAccountId === null || rec.poolAccountId !== poolAccountId) return null;
  const cells = rec.cells;
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_RECORD_CELLS) return null;
  if (!cells.every(isReservedCell)) return null;
  return { poolAccountId, cells: cells as ReservedCell[] };
}

// Gives the units of a resource in `failed` or `destroyed` back, once, in the transaction of the
// failure step or the destroy step. It throws only for a database error: a bad stored record
// opens a discrepancy and answers released:false, so that the refund in the same transaction
// stands (10.1).
export async function releaseCapacity(
  tx: Tx,
  input: { resourceId: string; clock: Clock },
): Promise<Result<ReleaseOutcome>> {
  const releaseRepo = capacityReleaseRepo(tx);
  const found = await releaseRepo.inspect(input.resourceId);
  if (found.kind === "none") {
    if (found.reason === "not_found") return { ok: false, error: "not_found" };
    return { ok: true, value: { released: false, reason: found.reason } };
  }
  if (found.state !== "failed" && found.state !== "destroyed") {
    return { ok: true, value: { released: false, reason: "not_final" } };
  }
  const record = readRecord(found.record, found.poolAccountId);
  if (!record) {
    await releaseRepo.recordProblem(input.resourceId, "malformed_record");
    return { ok: true, value: { released: false, reason: "malformed_record" } };
  }
  const rows = await capacityRepo(tx).lockCells({
    accountId: record.poolAccountId,
    cells: record.cells.map((c) => ({ region: c.region, quotaCode: c.quotaCode })),
  });
  const plan = planRelease(rows, record.cells);
  if (plan.missing.length > 0) {
    await releaseRepo.recordProblem(input.resourceId, "row_missing");
    return { ok: true, value: { released: false, reason: "row_missing" } };
  }
  if (!(await releaseRepo.mark(input.resourceId, input.clock.now().toISOString()))) {
    return { ok: true, value: { released: false, reason: "already_released" } };
  }
  await capacityRepo(tx).setUsed(plan.changes);
  return { ok: true, value: { released: true, cells: record.cells, clamped: plan.clamped } };
}
