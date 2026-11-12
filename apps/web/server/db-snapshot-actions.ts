import { decideDestructive } from "@tc/core";
import {
  FAMILY_DESTROY_LIMIT,
  FAMILY_WRITE_LIMIT,
  Refusal,
  audit,
  frame,
  nameOf,
  ownResource,
  parseOf,
  record,
  uuidField,
} from "./family-actions.ts";
import type { FamilyActionDeps, FamilyResult } from "./family-actions.ts";
import { MAX_MANUAL_BACKUPS } from "./extras-actions.ts";

// WPU-G9. The cores of the manual snapshots of a database (Backups tab of /databases/[id]). R9 order in
// each: authenticate, authorize (the fresh sign-in of a destructive action, the flag, the ownership),
// validate, rate limit, execute (an operation row: R1), audit. The key of the operation is the request
// id of the page (R7). A snapshot is billed per GB-month of stored size, so nothing is created while the
// market has no snapshot price (R16). Restore is not here: it is a NEW database and goes through the
// order flow (createDatabaseDraftCore, mode "snapshot" or "point_in_time").

const LABEL = /^[A-Za-z0-9 ._-]{1,60}$/;

export async function createDbSnapshotCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const databaseId = uuidField(input, "databaseId", bad);
  const requestId = uuidField(input, "requestId", bad);
  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (!LABEL.test(name)) bad["name"] = "invalid";
  return frame(
    deps,
    { destructive: false, limits: FAMILY_WRITE_LIMIT("db.snapshot") },
    parseOf(bad),
    async (repos) => {
      const database = await ownResource(repos, "database", databaseId);
      // A stopped database cannot be snapshotted.
      if (database.state !== "active") throw new Refusal("not_allowed");
      // R16: a market with no usable price sells no snapshot.
      if ((await repos.snapshotPriceOn?.()) !== true)
        throw new Refusal("not_allowed", { price: "unavailable" });
      const existing = await repos.resources.listChildren(database.id, "backup");
      const manual = existing.filter((b) => record(b.config)["final"] !== true).length;
      if (manual >= MAX_MANUAL_BACKUPS) throw new Refusal("not_allowed");
      const made = await repos.resources.createBackupRow({
        id: requestId,
        parentId: database.id,
        displayName: name,
      });
      if (!made.ok) throw new Refusal(made.error === "validation" ? "validation" : "not_found");
      const written = await repos.operations.request({
        resourceId: made.value.id,
        kind: "create_backup",
        idempotencyKey: `db-snapshot-create:${requestId}`,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, "db.snapshot_create", made.value.id);
      return { ok: true, done: "snapshotCreated" };
    },
  );
}

/** Destructive: a fresh sign-in, the typed name and the guard (R13, U10). */
export async function deleteDbSnapshotCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const backupId = uuidField(input, "backupId", bad);
  const requestId = uuidField(input, "requestId", bad);
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: FAMILY_DESTROY_LIMIT("db.snapshot") },
    parseOf(bad),
    async (repos) => {
      const backup = await ownResource(repos, "backup", backupId);
      const parent =
        backup.parentResourceId === null
          ? null
          : await repos.resources.get(backup.parentResourceId);
      if (parent === null || parent.family !== "database") throw new Refusal("not_found");
      const isFinal = record(backup.config)["final"] === true;
      // The final snapshot belongs to the lifecycle (it is kept for the restore window).
      if (backup.state !== "active" || isFinal) throw new Refusal("not_allowed");
      if (
        !decideDestructive("delete_backup", {
          subscriptionStatus: null,
          family: backup.family,
          hasFinalSnapshot: false,
          isFinalBackup: isFinal,
        })
      ) {
        throw new Refusal("not_allowed");
      }
      const name = nameOf(backup.config);
      if (name === "" || typed !== name) throw new Refusal("name_mismatch");
      const written = await repos.operations.request({
        resourceId: backup.id,
        kind: "delete_backup",
        idempotencyKey: `db-snapshot-delete:${requestId}`,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, "db.snapshot_delete", backup.id);
      return { ok: true, done: "snapshotDeleting", approval: written.value.needsApproval };
    },
  );
}
