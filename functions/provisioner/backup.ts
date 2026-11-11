import {
  createBackupAdapter,
  createDiskAdapter,
  type BackupDeps,
  type ProductAdapter,
} from "@tc/aws";
import { awsResourceName } from "@tc/core";
import { ensureFinalBackup, listBackupsOf, markFinalBackup, withTx } from "@tc/db";

// The production dependencies of the backup and disk adapters (WP5-T1, WP5-T2): the child backup
// rows of R13, each in a short transaction of its own, because the adapter runs outside any
// transaction. The customer id comes from the resource row of the operation, never from a payload (R8).
export function backupDeps(): BackupDeps {
  return {
    listBackups: (input) => withTx((tx) => listBackupsOf(tx, input)),
    ensureFinalBackup: (input) => withTx((tx) => ensureFinalBackup(tx, input)),
    markFinalBackup: ({ id, customerId, sizeGb }) =>
      withTx((tx) =>
        markFinalBackup(tx, { id, customerId, sizeGb, awsName: awsResourceName("snapshot", id) }),
      ),
  };
}

export function backupAdapter(): ProductAdapter<unknown> {
  return createBackupAdapter(backupDeps()) as ProductAdapter<unknown>;
}

export function diskAdapter(): ProductAdapter<unknown> {
  return createDiskAdapter(backupDeps()) as ProductAdapter<unknown>;
}
