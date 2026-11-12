import type { Result } from "../types";
import type { RestoreCandidate } from "./restore";

// WPU-B5 item 26. The pure rule of a NEW disk made from a snapshot of a disk of the customer
// (CreateDiskFromSnapshot). It creates a priced resource, so it goes through the order flow like every
// purchase: this rule runs in the draft and again in the purchase transaction, on rows read through the
// tenant-scoped repository (R8).

export interface DiskSnapshotRestoreCheck {
  readonly requested: string;
  /** null = missing or another customer's row: the tenant-scoped read answers both alike (R8). */
  readonly backup: RestoreCandidate | null;
  readonly source: RestoreCandidate | null;
  /** The size in GB of the disk the snapshot was taken from (NaN when unknown). */
  readonly sourceSizeGb: number;
  /** The size in GB asked for the new disk. */
  readonly sizeGb: number;
  readonly region: string;
}

const invalid = (field: string, value: string): Result<never> => ({
  ok: false,
  error: "validation",
  fields: { [field]: value },
});

const isSize = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/**
 * The snapshot is the customer's own, `active`, and the child of a disk of the customer (the disk may
 * be destroyed already: the final snapshot of a deleted disk restores to a new one). The new disk is in
 * the Region of the snapshot (a snapshot cannot cross a Region) and not smaller than the source disk
 * (Lightsail refuses a smaller size). Anything else is a refusal (R16).
 */
export function checkDiskSnapshotRestore(input: DiskSnapshotRestoreCheck): Result<string> {
  const { backup, source } = input;
  if (
    backup === null ||
    backup.id !== input.requested ||
    backup.family !== "backup" ||
    backup.state !== "active" ||
    backup.parentResourceId === null ||
    source === null ||
    source.id !== backup.parentResourceId ||
    source.family !== "disk"
  ) {
    return invalid("restoreFromBackupId", "invalid");
  }
  if (backup.region !== input.region) return invalid("region", "invalid");
  if (!isSize(input.sourceSizeGb) || !isSize(input.sizeGb)) return invalid("sizeGb", "unavailable");
  if (input.sizeGb < input.sourceSizeGb) return invalid("sizeGb", "too_small");
  return { ok: true, value: backup.id };
}
