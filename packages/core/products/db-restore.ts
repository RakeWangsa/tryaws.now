import type { Result } from "../types";
import type { RestoreCandidate } from "./restore";

// WPU-G9. The pure rules of the two ways to start a NEW database from an old one: a manual snapshot
// (CreateRelationalDatabaseFromSnapshot) and a point in time (the same call with a restore time).
// Both create a priced resource, so both go through the order flow; these rules run in the draft and
// again in the purchase transaction on rows read through the tenant-scoped repository (R8).

/** Lightsail keeps the automatic backups of a database 7 days (docs, 2026-11-12). */
export const DB_BACKUP_RETENTION_DAYS = 7;
/** The latest restorable time of a database is a few minutes behind now. */
export const PITR_LAG_MINUTES = 5;

const invalid = (field: string, value: string): Result<never> => ({
  ok: false,
  error: "validation",
  fields: { [field]: value },
});

const isSize = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

export interface DbSnapshotRestoreCheck {
  readonly requested: string;
  /** null = missing or another customer's row (R8). */
  readonly backup: RestoreCandidate | null;
  readonly source: RestoreCandidate | null;
  readonly sourceDiskGb: number;
  readonly planDiskGb: number;
  readonly planRegion: string;
}

/**
 * The snapshot is the customer's own, `active`, and the child of a database of the customer (the
 * database may be destroyed already: the final snapshot of a deleted database restores to a new one).
 * The new plan is in the Region of the snapshot and its disk is not smaller than the source's
 * (Lightsail may create a larger database, not a smaller one). Anything else is a refusal (R16).
 */
export function checkDbSnapshotRestore(input: DbSnapshotRestoreCheck): Result<string> {
  const { backup, source } = input;
  if (
    backup === null ||
    backup.id !== input.requested ||
    backup.family !== "backup" ||
    backup.state !== "active" ||
    backup.parentResourceId === null ||
    source === null ||
    source.id !== backup.parentResourceId ||
    source.family !== "database"
  ) {
    return invalid("restoreFromBackupId", "invalid");
  }
  if (backup.region !== input.planRegion) return invalid("region", "invalid");
  if (!isSize(input.sourceDiskGb) || !isSize(input.planDiskGb)) {
    return invalid("productId", "unavailable");
  }
  if (input.planDiskGb < input.sourceDiskGb) return invalid("productId", "too_small");
  return { ok: true, value: backup.id };
}

/** The instants a point-in-time restore may name at `now`. */
export function pointInTimeWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - DB_BACKUP_RETENTION_DAYS * 24 * 3600 * 1000),
    to: new Date(now.getTime() - PITR_LAG_MINUTES * 60 * 1000),
  };
}

export interface DbPointInTimeCheck {
  readonly requested: string;
  readonly source: RestoreCandidate | null;
  readonly sourceDiskGb: number;
  readonly planDiskGb: number;
  readonly planRegion: string;
  /** The ISO instant the customer asked for. */
  readonly at: string;
  readonly now: Date;
}

const LIVE = ["active", "stopped", "suspended"];

/** The source is the customer's own database that still exists; the instant is inside the window. */
export function checkDbPointInTime(input: DbPointInTimeCheck): Result<string> {
  const { source } = input;
  if (
    source === null ||
    source.id !== input.requested ||
    source.family !== "database" ||
    !LIVE.includes(source.state)
  ) {
    return invalid("restoreSourceId", "invalid");
  }
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime()) || Number.isNaN(input.now.getTime())) {
    return invalid("restoreTime", "invalid");
  }
  const w = pointInTimeWindow(input.now);
  if (at.getTime() < w.from.getTime() || at.getTime() > w.to.getTime()) {
    return invalid("restoreTime", "out_of_range");
  }
  if (source.region !== input.planRegion) return invalid("region", "invalid");
  if (!isSize(input.sourceDiskGb) || !isSize(input.planDiskGb)) {
    return invalid("productId", "unavailable");
  }
  if (input.planDiskGb < input.sourceDiskGb) return invalid("productId", "too_small");
  return { ok: true, value: source.id };
}
