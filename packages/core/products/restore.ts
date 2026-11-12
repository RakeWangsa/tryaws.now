import type { Result } from "../types";

/** The few fields of a resource row that the rule needs; the caller read it for the customer's scope. */
export interface RestoreCandidate {
  readonly id: string;
  readonly family: string;
  readonly state: string;
  readonly parentResourceId: string | null;
  readonly region: string | null;
}

export interface RestoreCheck {
  readonly requested: string;
  /** null = missing or another customer's row: the tenant-scoped read answers both alike (R8). */
  readonly backup: RestoreCandidate | null;
  readonly source: RestoreCandidate | null;
  readonly sourceDiskGb: number;
  readonly planDiskGb: number;
  readonly planRegion: string;
}

const invalid = (field: string, value: string): Result<never> => ({
  ok: false,
  error: "validation",
  fields: { [field]: value },
});

const isSize = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/**
 * Pure rule of restoreToNewServer (16.10 Backups): the backup is the customer's own, `active`, and
 * the child of a Linux server of the customer (its state does not matter: the final backup of a
 * destroyed server may be restored to a new one). The new plan lives in the Region of the backup
 * (a snapshot cannot cross a Region) and its disk is not smaller than the disk of the server the
 * backup was taken from (Lightsail refuses a smaller disk). Any surprise is a refusal (R16), and
 * "not yours" and "missing" give one answer (R8).
 */
export function checkRestore(input: RestoreCheck): Result<string> {
  const { backup, source } = input;
  if (
    backup === null ||
    backup.id !== input.requested ||
    backup.family !== "backup" ||
    backup.state !== "active" ||
    backup.parentResourceId === null ||
    source === null ||
    source.id !== backup.parentResourceId ||
    source.family !== "linux_instance"
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
