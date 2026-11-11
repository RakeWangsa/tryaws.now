import {
  CreateDiskSnapshotCommand,
  CreateInstanceSnapshotCommand,
  CreateInstancesFromSnapshotCommand,
  DeleteDiskSnapshotCommand,
  DeleteInstanceSnapshotCommand,
  DisableAddOnCommand,
  EnableAddOnCommand,
  GetDiskSnapshotCommand,
  GetInstanceCommand,
  GetInstanceSnapshotCommand,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  stepDone,
  stepNext,
  stepWait,
  type OperationKind,
  type StepResult,
} from "@tc/core";
import {
  checkWaitBudget,
  fail,
  hasTag,
  ignoreNotFound,
  isUuid,
  lightsailOf,
  orNull,
  payloadOf,
  pollAt,
  tagsFor,
} from "./shared";
import type { LinuxInstanceDeps } from "./linux-instance";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

/**
 * What the backup and disk adapters need and OpCtx (contract F) does not carry: the database. The
 * function that runs the adapter supplies it, with the customer id taken from the resource row and
 * never from a payload (R8).
 *
 * R13 and the lifecycle guard (packages/core/lifecycle): a final snapshot is a child `backup`
 * resource with config.final = true that the adapter creates, and the guard counts it only when it
 * is `active` and was created at or after the latest final_snapshot operation.
 */
export interface BackupDeps {
  /** The child backup rows of a parent that are not destroyed. */
  listBackups(input: {
    readonly customerId: string;
    readonly parentResourceId: string;
  }): Promise<readonly { readonly id: string }[]>;
  /**
   * The child backup row (state `creating`, config.final = true) of this final_snapshot operation. The
   * first call makes it, every later call of the same operation returns the same row (R7).
   */
  ensureFinalBackup(input: {
    readonly customerId: string;
    readonly parentResourceId: string;
    readonly operationId: string;
  }): Promise<{ readonly id: string }>;
  /** The snapshot is available: the row becomes `active`, gets its AWS name and its size. */
  markFinalBackup(input: {
    readonly id: string;
    readonly customerId: string;
    readonly sizeGb: number | null;
  }): Promise<void>;
}

export interface BackupConfig {
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string | null;
}

export type SnapshotSource = "instance" | "disk";

const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;
const HOUR = /^([01]\d|2[0-3]):00$/;

export function sourceOfFamily(family: string): SnapshotSource | null {
  if (family === "linux_instance" || family === "windows_instance") return "instance";
  if (family === "disk") return "disk";
  return null;
}

function parentName(source: SnapshotSource, parentId: string): string {
  return awsResourceName(source === "instance" ? "instance" : "disk", parentId);
}

interface SnapshotView {
  readonly state: string | undefined;
  readonly sizeGb: number | null;
  readonly tags: readonly { key?: string; value?: string }[] | undefined;
}

/** Instance and disk snapshots behind one small interface. */
function snapshotApi(ctx: OpCtx<unknown>, source: SnapshotSource) {
  const lightsail = lightsailOf(ctx);
  return {
    async get(name: string): Promise<SnapshotView | null> {
      if (source === "instance") {
        const got = await orNull(() =>
          lightsail.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: name })),
        );
        const s = got?.instanceSnapshot;
        if (s === undefined) return null;
        return { state: s.state, sizeGb: s.sizeInGb ?? null, tags: s.tags };
      }
      const got = await orNull(() =>
        lightsail.send(new GetDiskSnapshotCommand({ diskSnapshotName: name })),
      );
      const s = got?.diskSnapshot;
      if (s === undefined) return null;
      return { state: s.state, sizeGb: s.sizeInGb ?? null, tags: s.tags };
    },
    async create(
      parent: string,
      name: string,
      tags: { key: string; value: string }[],
    ): Promise<void> {
      if (source === "instance") {
        await lightsail.send(
          new CreateInstanceSnapshotCommand({
            instanceName: parent,
            instanceSnapshotName: name,
            tags,
          }),
        );
      } else {
        await lightsail.send(
          new CreateDiskSnapshotCommand({ diskName: parent, diskSnapshotName: name, tags }),
        );
      }
    },
    async remove(name: string): Promise<void> {
      await ignoreNotFound(() =>
        source === "instance"
          ? lightsail.send(new DeleteInstanceSnapshotCommand({ instanceSnapshotName: name }))
          : lightsail.send(new DeleteDiskSnapshotCommand({ diskSnapshotName: name })),
      );
    },
  };
}

type Ensured =
  | { readonly kind: "created" }
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly sizeGb: number | null };

/**
 * One idempotent step: find the snapshot by its generated name; if it is not there, create it; if it
 * is there it must carry our tag, else it is not ours (R16). A retry never makes a second snapshot.
 */
async function ensureSnapshot(
  ctx: OpCtx<unknown>,
  source: SnapshotSource,
  parent: string,
  snapshotName: string,
  backupId: string,
): Promise<Ensured> {
  const api = snapshotApi(ctx, source);
  const found = await api.get(snapshotName);
  if (found === null) {
    await api.create(parent, snapshotName, tagsFor(ctx, backupId));
    return { kind: "created" };
  }
  if (!hasTag(found.tags, "tc:resource", backupId)) throw fail("conflict");
  // An instance snapshot is `available`, a disk snapshot `completed`.
  if (found.state === "available" || found.state === "completed") {
    return { kind: "ready", sizeGb: found.sizeGb };
  }
  if (found.state === "error") throw fail("upstream_unavailable");
  checkWaitBudget(ctx);
  return { kind: "pending" };
}

/** The final snapshot of an instance or a disk (R13). */
export async function runFinalSnapshot(ctx: OpCtx<unknown>, deps: BackupDeps): Promise<StepResult> {
  const source = sourceOfFamily(ctx.resource.family);
  if (source === null) throw fail("validation");
  const backup = await deps.ensureFinalBackup({
    customerId: ctx.resource.customerId,
    parentResourceId: ctx.resource.id,
    operationId: ctx.operation.id,
  });
  const snapshotName = awsResourceName("snapshot", backup.id);
  const r = await ensureSnapshot(
    ctx,
    source,
    parentName(source, ctx.resource.id),
    snapshotName,
    backup.id,
  );
  if (r.kind === "ready") {
    await deps.markFinalBackup({
      id: backup.id,
      customerId: ctx.resource.customerId,
      sizeGb: r.sizeGb,
    });
    return stepDone();
  }
  return stepWait("wait_snapshot", pollAt(ctx));
}

/** Every backup child of the resource goes (14 days after the destroy; the guard checks `ended`). */
export async function runPurgeSnapshots(
  ctx: OpCtx<unknown>,
  deps: BackupDeps,
): Promise<StepResult> {
  const source = sourceOfFamily(ctx.resource.family);
  if (source === null) throw fail("validation");
  const api = snapshotApi(ctx, source);
  const backups = await deps.listBackups({
    customerId: ctx.resource.customerId,
    parentResourceId: ctx.resource.id,
  });
  for (const b of backups) await api.remove(awsResourceName("snapshot", b.id));
  return stepDone();
}

const BACKUP_STATES = new Set(["active", "stopped", "suspended"]);

/** Family `backup`: a manual snapshot of an instance or a disk. The web tier writes the row. */
export function createBackupAdapter(): ProductAdapter<BackupConfig> {
  async function parentOf(ctx: OpCtx<BackupConfig>) {
    const id = ctx.resource.parentResourceId;
    if (id === null) throw fail("validation");
    // R8: the parent is the customer's own resource or it is nothing.
    const parent = await ctx.owned(id);
    if (parent === null) throw fail("validation");
    const source = sourceOfFamily(parent.family);
    if (source === null) throw fail("validation");
    return { parent, source };
  }

  async function createBackup(ctx: OpCtx<BackupConfig>): Promise<StepResult> {
    const { parent, source } = await parentOf(ctx);
    if (!BACKUP_STATES.has(parent.state)) throw fail("validation");
    const snapshotName = awsResourceName("snapshot", ctx.resource.id);
    const r = await ensureSnapshot(
      ctx,
      source,
      parentName(source, parent.id),
      snapshotName,
      ctx.resource.id,
    );
    if (r.kind === "ready") {
      return stepDone({
        state: "active",
        awsName: snapshotName,
        ...(r.sizeGb === null ? {} : { configMerge: { sizeGb: r.sizeGb } }),
      });
    }
    return stepWait("wait_snapshot", pollAt(ctx));
  }

  async function deleteBackup(ctx: OpCtx<BackupConfig>): Promise<StepResult> {
    // The parent row may be destroyed already (a backup outlives its server) but it is still the
    // customer's own row.
    const { source } = await parentOf(ctx);
    await snapshotApi(ctx, source).remove(awsResourceName("snapshot", ctx.resource.id));
    return stepDone({ state: "destroyed" });
  }

  const refuse = async (): Promise<StepResult> => {
    throw fail("validation");
  };

  return {
    family: "backup",
    parseConfig(input: unknown): BackupConfig {
      const name =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).displayName
          : undefined;
      return {
        displayName: typeof name === "string" && DISPLAY_NAME.test(name) ? name : null,
      };
    },
    aws: {
      create: refuse,
      suspend: refuse,
      resume: refuse,
      finalSnapshot: refuse,
      destroy: refuse,
      purgeSnapshots: refuse,
      async describe(ctx): Promise<LiveState> {
        const { source } = await parentOf(ctx);
        const found = await snapshotApi(ctx, source).get(
          awsResourceName("snapshot", ctx.resource.id),
        );
        return { state: found?.state ?? "missing" };
      },
      async action(kind: OperationKind, ctx): Promise<StepResult> {
        switch (kind) {
          case "create_backup":
            return createBackup(ctx);
          case "delete_backup":
            return deleteBackup(ctx);
          default:
            // Anything else is not a backup action: refuse (R16).
            throw fail("validation");
        }
      },
    },
  };
}

function parseAutoBackup(
  payload: unknown,
): { enabled: false } | { enabled: true; hour: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { enabled, hour } = payload as Record<string, unknown>;
  if (enabled === false) return { enabled: false };
  if (enabled === true && typeof hour === "string" && HOUR.test(hour)) {
    return { enabled: true, hour };
  }
  return null;
}

const RESTORE_STEPS = new Set(["restore_instance", "wait_restored"]);

/**
 * The Linux instance adapter with the backup features of WP5-T1 added around it; linux-instance.ts is
 * not touched. Added: set_auto_backup, restore to a new server (a `create` whose payload names a
 * backup), the final snapshot as a child backup row (R13) and the purge of every child backup.
 */
export function withBackups<C extends { readonly productId: string }>(
  base: ProductAdapter<C>,
  deps: BackupDeps,
  launch: Pick<LinuxInstanceDeps, "loadLaunch">,
): ProductAdapter<C> {
  async function snapshotToRestore(ctx: OpCtx<C>): Promise<string> {
    const backupId = payloadOf(ctx).restoreFromBackupId;
    if (!isUuid(backupId)) throw fail("validation");
    // R8: both rows are the customer's own, or the restore is refused.
    const backup = await ctx.owned(backupId);
    if (
      backup === null ||
      backup.family !== "backup" ||
      backup.state !== "active" ||
      backup.parentResourceId === null
    ) {
      throw fail("validation");
    }
    const source = await ctx.owned(backup.parentResourceId);
    if (source === null || source.family !== "linux_instance") throw fail("validation");
    return awsResourceName("snapshot", backup.id);
  }

  async function restoreInstance(ctx: OpCtx<C>): Promise<StepResult> {
    const snapshotName = await snapshotToRestore(ctx);
    const spec = await launch.loadLaunch({
      customerId: ctx.resource.customerId,
      productId: ctx.config.productId,
      keyPairId: null,
    });
    if (spec === null) throw fail("validation");
    const name = awsResourceName("instance", ctx.resource.id);
    const lightsail = lightsailOf(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetInstanceCommand({ instanceName: name })),
    );
    if (found?.instance !== undefined) {
      // A retry continues with what an earlier try made, if it is ours.
      if (!hasTag(found.instance.tags, "tc:resource", ctx.resource.id)) throw fail("conflict");
      return stepNext("wait_restored", { awsName: name });
    }
    await lightsail.send(
      new CreateInstancesFromSnapshotCommand({
        instanceNames: [name],
        availabilityZone: `${ctx.region}a`,
        instanceSnapshotName: snapshotName,
        bundleId: spec.bundleId,
        ipAddressType: "ipv4",
        tags: tagsFor(ctx, ctx.resource.id, "linux"),
      }),
    );
    return stepNext("wait_restored", { awsName: name });
  }

  async function waitRestored(ctx: OpCtx<C>): Promise<StepResult> {
    const got = await lightsailOf(ctx).send(
      new GetInstanceCommand({ instanceName: awsResourceName("instance", ctx.resource.id) }),
    );
    const state = got.instance?.state?.name;
    // The firewall of the restored image is not proven until the bootstrap marker is: the linux
    // steps verify it before the static IP (R16).
    if (state === "running") return stepNext("verify_bootstrap");
    if (state === "pending" || state === undefined) {
      checkWaitBudget(ctx);
      return stepWait("wait_restored", pollAt(ctx));
    }
    throw fail("upstream_unavailable");
  }

  async function setAutoBackup(ctx: OpCtx<C>): Promise<StepResult> {
    // Lightsail has no AutoSnapshot add-on for Windows instances.
    if (ctx.resource.family !== "linux_instance") throw fail("validation");
    const request = parseAutoBackup(ctx.operation.payload);
    if (request === null) throw fail("validation");
    const resourceName = awsResourceName("instance", ctx.resource.id);
    const lightsail = lightsailOf(ctx);
    if (request.enabled) {
      await lightsail.send(
        new EnableAddOnCommand({
          resourceName,
          addOnRequest: {
            addOnType: "AutoSnapshot",
            autoSnapshotAddOnRequest: { snapshotTimeOfDay: request.hour },
          },
        }),
      );
      return stepDone({
        configMerge: { autoBackup: { enabled: true, hour: request.hour } },
      });
    }
    await lightsail.send(new DisableAddOnCommand({ resourceName, addOnType: "AutoSnapshot" }));
    return stepDone({ configMerge: { autoBackup: { enabled: false } } });
  }

  return {
    ...base,
    aws: {
      ...base.aws,
      async create(ctx) {
        const step = ctx.operation.step;
        const restore =
          step === "restore_instance" ||
          step === "wait_restored" ||
          (step === null && payloadOf(ctx).restoreFromBackupId !== undefined);
        if (!restore) return base.aws.create(ctx);
        if (step === null || step === "restore_instance") return restoreInstance(ctx);
        if (step !== null && RESTORE_STEPS.has(step)) return waitRestored(ctx);
        throw fail("internal");
      },
      finalSnapshot: (ctx) => runFinalSnapshot(ctx, deps),
      purgeSnapshots: (ctx) => runPurgeSnapshots(ctx, deps),
      async action(kind, ctx) {
        if (kind === "set_auto_backup") return setAutoBackup(ctx);
        return base.aws.action(kind, ctx);
      },
    },
  };
}
