import {
  AttachDiskCommand,
  CreateDiskCommand,
  CreateDiskFromSnapshotCommand,
  DeleteDiskCommand,
  DetachDiskCommand,
  GetDiskCommand,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  stepDone,
  stepNext,
  stepWait,
  type OperationKind,
  type StepResult,
} from "@tc/core";
import { runFinalSnapshot, runPurgeSnapshots, type BackupDeps } from "./backup";
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
import type { LiveState, OpCtx, ProductAdapter } from "./types";

export interface DiskConfig {
  readonly productId: string | null;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
  readonly sizeGb: number;
}

const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;
// WPU-Z19: Lightsail block storage, per the quotas page (https://docs.aws.amazon.com/general/latest/gr/lightsail.html,
// read 2026-11-14): "Minimum block storage disk space ... 8 Gigabytes", "Maximum block storage disk space ... 16,000
// Gigabytes" per disk, in each supported Region. 16,384 is on no AWS page.
const MIN_GB = 8;
const MAX_GB = 16_000;
// WPU-Z19: the AttachDisk `diskPath` value only (the API reference's example is /dev/xvdf). It is NOT the Linux device
// name: on instances created after 2023-06-29 (all of this platform's) the extra disk shows as /dev/nvme1n1 and up, in
// an order that is not guaranteed; the panel tells the customer to find it with lsblk. The range f-p: tc-pool-dev.
const DISK_PATH = /^\/dev\/xvd[f-p]$/;
const ATTACH_STATES = new Set(["active", "stopped"]);

export function parseDiskConfig(input: unknown): DiskConfig | null {
  if (typeof input !== "object" || input === null) return null;
  const { productId, region, displayName, sizeGb } = input as Record<string, unknown>;
  if (productId !== undefined && productId !== null && !isUuid(productId)) return null;
  if (typeof region !== "string" || !REGION.test(region)) return null;
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) return null;
  if (typeof sizeGb !== "number" || !Number.isInteger(sizeGb)) return null;
  if (sizeGb < MIN_GB || sizeGb > MAX_GB) return null;
  return {
    productId: typeof productId === "string" ? productId : null,
    region,
    displayName,
    sizeGb,
  };
}

/** The payload of attach_disk is written by the web tier: it is input (R9). */
function parseAttach(payload: unknown): { instanceId: string; diskPath: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { instanceId, diskPath } = payload as Record<string, unknown>;
  if (!isUuid(instanceId)) return null;
  if (typeof diskPath !== "string" || !DISK_PATH.test(diskPath)) return null;
  return { instanceId, diskPath };
}

/**
 * Family `disk`: an Amazon Lightsail block storage disk. Create makes the disk in the zone the
 * instance adapter uses (`<region>a`); attach and detach are customer actions; the final snapshot
 * is a child backup row (R13, same contract as the instance).
 */
export function createDiskAdapter(deps: BackupDeps): ProductAdapter<DiskConfig> {
  const diskName = (ctx: OpCtx<DiskConfig>) => awsResourceName("disk", ctx.resource.id);

  async function ourDisk(ctx: OpCtx<DiskConfig>) {
    const got = await orNull(() =>
      lightsailOf(ctx).send(new GetDiskCommand({ diskName: diskName(ctx) })),
    );
    const disk = got?.disk;
    if (disk === undefined) return null;
    if (!hasTag(disk.tags, "tc:resource", ctx.resource.id)) throw fail("conflict");
    return disk;
  }

  /**
   * WPU-B5 item 26. The snapshot a restore starts from, as an AWS name made from the id of the backup
   * row (R11). R8: the payload names rows; the snapshot must be the customer's own, `active`, the child
   * of a disk of the customer, and the new disk must not be smaller than that disk (Lightsail refuses a
   * smaller size). Anything else is a refusal (R16).
   */
  async function snapshotToRestore(ctx: OpCtx<DiskConfig>): Promise<string> {
    const backupId = payloadOf(ctx).restoreFromBackupId;
    if (!isUuid(backupId)) throw fail("validation");
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
    if (source === null || source.family !== "disk") throw fail("validation");
    const sourceSize = (source.config as { sizeGb?: unknown } | null)?.sizeGb;
    if (typeof sourceSize !== "number" || !(sourceSize <= ctx.config.sizeGb)) {
      throw fail("validation");
    }
    return awsResourceName("snapshot", backup.id);
  }

  async function create(ctx: OpCtx<DiskConfig>): Promise<StepResult> {
    const name = diskName(ctx);
    switch (ctx.operation.step) {
      case null:
      case "create_disk": {
        // A retry continues with what an earlier try made, if it is ours.
        if ((await ourDisk(ctx)) === null) {
          if (payloadOf(ctx).restoreFromBackupId !== undefined) {
            const snapshotName = await snapshotToRestore(ctx);
            await lightsailOf(ctx).send(
              new CreateDiskFromSnapshotCommand({
                diskName: name,
                diskSnapshotName: snapshotName,
                availabilityZone: `${ctx.region}a`,
                sizeInGb: ctx.config.sizeGb,
                tags: tagsFor(ctx, ctx.resource.id),
              }),
            );
          } else {
            await lightsailOf(ctx).send(
              new CreateDiskCommand({
                diskName: name,
                availabilityZone: `${ctx.region}a`,
                sizeInGb: ctx.config.sizeGb,
                tags: tagsFor(ctx, ctx.resource.id),
              }),
            );
          }
        }
        return stepNext("wait_available", { awsName: name });
      }
      case "wait_available": {
        const disk = await ourDisk(ctx);
        const state = disk?.state;
        if (state === "available" || state === "in-use") {
          return stepDone({ state: "active", awsName: name });
        }
        if (state === "error") throw fail("upstream_unavailable");
        checkWaitBudget(ctx);
        return stepWait("wait_available", pollAt(ctx));
      }
      default:
        throw fail("internal");
    }
  }

  async function resolveInstance(ctx: OpCtx<DiskConfig>, instanceId: string) {
    // R8: another customer's id, a missing one and a wrong family all give a refusal.
    const instance = await ctx.owned(instanceId);
    if (
      instance === null ||
      instance.family !== "linux_instance" ||
      !ATTACH_STATES.has(instance.state)
    ) {
      throw fail("validation");
    }
    return instance;
  }

  async function attach(ctx: OpCtx<DiskConfig>): Promise<StepResult> {
    const request = parseAttach(ctx.operation.payload);
    if (request === null) throw fail("validation");
    const instance = await resolveInstance(ctx, request.instanceId);
    const instanceName = awsResourceName("instance", instance.id);
    const disk = await ourDisk(ctx);
    if (disk === null) throw fail("validation");
    if (ctx.operation.step === "wait_attached") {
      if (disk.isAttached === true && disk.attachedTo === instanceName) {
        return stepDone({
          configMerge: { attachedInstanceId: instance.id, diskPath: request.diskPath },
        });
      }
      if (disk.state === "error") throw fail("upstream_unavailable");
      checkWaitBudget(ctx);
      return stepWait("wait_attached", pollAt(ctx));
    }
    if (ctx.operation.step !== null && ctx.operation.step !== "attach") throw fail("internal");
    if (disk.isAttached === true) {
      // Attached to our instance: continue. To anything else: not ours to touch (R16).
      if (disk.attachedTo !== instanceName) throw fail("conflict");
    } else {
      await lightsailOf(ctx).send(
        new AttachDiskCommand({
          diskName: diskName(ctx),
          instanceName,
          diskPath: request.diskPath,
        }),
      );
    }
    return stepWait("wait_attached", pollAt(ctx));
  }

  async function detach(ctx: OpCtx<DiskConfig>): Promise<StepResult> {
    const done = () => stepDone({ configMerge: { attachedInstanceId: null } });
    if (ctx.operation.step === "wait_detached") {
      const disk = await ourDisk(ctx);
      if (disk === null || disk.isAttached !== true) return done();
      checkWaitBudget(ctx);
      return stepWait("wait_detached", pollAt(ctx));
    }
    if (ctx.operation.step !== null && ctx.operation.step !== "detach") throw fail("internal");
    const disk = await ourDisk(ctx);
    if (disk === null) throw fail("validation");
    if (disk.isAttached !== true) return done();
    // VERIFY: the customer unmounts first; a detach under a mounted filesystem can lose data.
    await lightsailOf(ctx).send(new DetachDiskCommand({ diskName: diskName(ctx) }));
    return stepWait("wait_detached", pollAt(ctx));
  }

  async function destroy(ctx: OpCtx<DiskConfig>): Promise<StepResult> {
    const step = ctx.operation.step;
    if (step === null || step === "detach" || step === "wait_detached") {
      const disk = await ourDisk(ctx);
      if (disk === null) return stepNext("delete_disk");
      if (disk.isAttached === true) {
        if (step !== "wait_detached") {
          await lightsailOf(ctx).send(new DetachDiskCommand({ diskName: diskName(ctx) }));
        } else {
          checkWaitBudget(ctx);
        }
        return stepWait("wait_detached", pollAt(ctx));
      }
      return stepNext("delete_disk");
    }
    if (step === "delete_disk") {
      await ignoreNotFound(() =>
        lightsailOf(ctx).send(
          new DeleteDiskCommand({ diskName: diskName(ctx), forceDeleteAddOns: true }),
        ),
      );
      return stepDone({ state: "destroyed" });
    }
    throw fail("internal");
  }

  return {
    family: "disk",
    parseConfig(input: unknown): DiskConfig {
      const parsed = parseDiskConfig(input);
      if (parsed === null) throw fail("validation");
      return parsed;
    },
    aws: {
      create,
      // The disk stays as it is while the instance is suspended and goes with it (10.3).
      suspend: async () => stepDone(),
      resume: async () => stepDone(),
      finalSnapshot: (ctx) => runFinalSnapshot(ctx, deps),
      destroy,
      purgeSnapshots: (ctx) => runPurgeSnapshots(ctx, deps),
      async describe(ctx): Promise<LiveState> {
        const got = await orNull(() =>
          lightsailOf(ctx).send(new GetDiskCommand({ diskName: diskName(ctx) })),
        );
        return { state: got?.disk?.state ?? "missing" };
      },
      async action(kind: OperationKind, ctx): Promise<StepResult> {
        switch (kind) {
          case "attach_disk":
            return attach(ctx);
          case "detach_disk":
            return detach(ctx);
          default:
            // Anything else is not a disk action: refuse (R16).
            throw fail("validation");
        }
      },
    },
  };
}
