import {
  clearRetainedWithServer,
  type DiskRetentionOp,
  endDiskRetentionOps,
  lifecycleRepo,
  listDisksRetainedWithServer,
  lockDiskRetentionOps,
  meteringRepo,
  recordDiskHeld,
  type Tx,
} from "@tc/db";
import type { Logger } from "../operations/types";

// WPU-Y4 fix round 2. A server that leaves `retained` (the unpaid rule's payback, completeRestore) takes back the
// disks the cascade retained with it (retainAttachedDisks of @tc/db): in the same transaction each disk subscription
// gets the status it had before (`active` or `grace`), its destroy and final snapshot that never started are
// cancelled, its final backups stop being final (the same release as the server's own, R13), and the mark goes.
// Nothing is posted to the ledger (R5). Fix round 4: a disk is held (still retained, an attention item in
// `discrepancies`) only when its destroy may already have sent DeleteDisk. Runs as worker_rw (it reads
// operations). A disk the cascade
// found retained on its own keeps its own retention; only the mark is removed.

export interface ReleasedDisks {
  /** Disks whose subscription got its former status back. */
  readonly released: number;
  /** Disks left retained because a destroy of theirs may already have sent DeleteDisk (an attention item each). */
  readonly held: number;
}

// The disk adapter's destroy sends DeleteDisk in this step (packages/aws/adapters/disk.ts).
const DELETE_STEP = "delete_disk";

/**
 * WPU-X1. A final snapshot that started: it runs, it is at a step (wait_snapshot), or the provisioner claimed it
 * before. A `waiting` row with no step and no attempt was only blocked by the claim (fix round 1): not started. Its AWS snapshot may exist already, so a release lets it finish (its backup then ends as an
 * ordinary, deletable one: ensureFinalBackup and markFinalBackup of @tc/db) instead of ending it, which would leave
 * a snapshot that is billed and cannot be deleted. Pure.
 */
export function finalSnapshotStarted(
  op: Pick<DiskRetentionOp, "kind" | "state" | "step" | "attempts">,
): boolean {
  if (op.kind !== "final_snapshot") return false;
  // Fix round 1: `waiting` alone is not a start. The claim's block rule moves an operation to `waiting` with no
  // step and no attempt when another operation of the resource runs first; nothing was sent to AWS.
  return op.state === "running" || op.step !== null || op.attempts > 0;
}

const ENDED = ["succeeded", "failed"];

/**
 * Fix round 4: a disk is given back unless DeleteDisk may already have been sent (a destroy at the delete step,
 * running, or one that succeeded). Fix round 5: every other destroy and final snapshot of the disk is ended
 * (`failed`) in the same transaction, approved or not, under the lock of its row. WPU-X1: except a final snapshot
 * that started (finalSnapshotStarted), which finishes as an ordinary backup; the ids of the ended rows are logged.
 */
export async function releaseServerDisks(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
  log?: Logger,
): Promise<ReleasedDisks> {
  const disks = await listDisksRetainedWithServer(tx, input);
  const metering = meteringRepo(tx);
  let released = 0;
  let held = 0;
  for (const disk of disks) {
    const clear = () =>
      clearRetainedWithServer(tx, { customerId: input.customerId, diskId: disk.diskId });
    if (disk.status !== "retained" || disk.from === "retained") {
      await clear();
      continue;
    }
    // Fix round 5: the rows are locked against the provisioner's claim (M1) and decided on as locked.
    const ops = await lockDiskRetentionOps(tx, disk.diskId);
    const mayHaveDeleted = ops.some(
      (op) =>
        op.kind === "destroy" &&
        (op.state === "succeeded" || op.state === "running" || op.step === DELETE_STEP),
    );
    if (mayHaveDeleted) {
      held += 1;
      await recordDiskHeld(tx, { diskId: disk.diskId, serverId: input.serverId });
      // Ids and fixed words only (R14).
      log?.({
        event: "attached_disks",
        action: "held",
        diskId: disk.diskId,
        serverId: input.serverId,
      });
      continue;
    }
    // Fix round 5 (N1): every destroy of the disk that is not running and has not ended is ended (queued,
    // waiting, needs_approval, needs_attention, approved or not), so none stays alive under the period's key and
    // a later retention of the disk gets fresh rows (insertFreshOperation). WPU-X1: a final snapshot is ended
    // only when it never started; a started one finishes and its backup is an ordinary one (superseded below, or
    // made not final by ensureFinalBackup when its row comes after this release).
    const ended = await endDiskRetentionOps(tx, {
      diskId: disk.diskId,
      operationIds: ops
        .filter(
          (op) => op.state !== "running" && !ENDED.includes(op.state) && !finalSnapshotStarted(op),
        )
        .map((op) => op.id),
    });
    // One line for each ended operation: ids and fixed words only (R14).
    const kindOf = new Map(ops.map((op) => [op.id, op.kind]));
    for (const operationId of ended) {
      log?.({
        event: "attached_disks",
        action: "ended",
        diskId: disk.diskId,
        serverId: input.serverId,
        operationId,
        kind: kindOf.get(operationId) ?? "unknown",
      });
    }
    await metering.supersedeFinalBackups(disk.diskId);
    await lifecycleRepo(tx).setStatus(disk.subscriptionId, disk.from);
    await clear();
    released += 1;
  }
  return { released, held };
}

/**
 * WPU-Y4 fix round 2 (point 2). The server a disk is attached to (`config.attachedInstanceId`), or null. Pure.
 */
export function attachedServerOf(config: Record<string, unknown>): string | null {
  const v = config["attachedInstanceId"];
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
    ? v
    : null;
}

/** The server statuses during which a renewal of a disk attached to it is held (no charge). Pure. */
export function diskRenewalHeld(serverStatus: string | null): boolean {
  return serverStatus === "grace" || serverStatus === "retained";
}
