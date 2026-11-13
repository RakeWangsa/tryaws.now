import {
  clearRetainedWithServer,
  lifecycleRepo,
  listDisksRetainedWithServer,
  meteringRepo,
  recordDiskHeld,
  type Tx,
} from "@tc/db";

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
 * Fix round 4: a disk is given back unless DeleteDisk may already have been sent (a destroy at the delete step, or
 * one that succeeded). A destroy that was approved or started but has not reached that step does not hold the disk:
 * the guard checks again at every claim and refuses it while the server is not retained (R13, R16). Such a destroy
 * is left as it is (only an unstarted, unapproved one can be cancelled here) and ends refused.
 */
export async function releaseServerDisks(
  tx: Tx,
  input: { readonly customerId: string; readonly serverId: string },
  log?: (line: Record<string, unknown>) => void,
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
    const destroys = await metering.operationsOf(disk.diskId, ["destroy"]);
    const mayHaveDeleted = destroys.some(
      (op) => op.state === "succeeded" || op.step === DELETE_STEP,
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
    // What has not started is cancelled; anything else is refused by the guard when it is claimed.
    for (const op of [
      ...destroys,
      ...(await metering.operationsOf(disk.diskId, ["final_snapshot"])),
    ]) {
      if ((op.state === "queued" || op.state === "needs_approval") && !op.approved) {
        await metering.cancelUnstarted(op.id);
      }
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
