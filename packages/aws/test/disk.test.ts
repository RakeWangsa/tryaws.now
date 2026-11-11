import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import type { BackupDeps } from "../adapters/backup";
import { createDiskAdapter } from "../adapters/disk";
import type { OpCtx, ResourceView } from "../adapters/types";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DISK_ID = "44444444-5555-4666-8777-888888888888";
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const BACKUP_ID = "22222222-3333-4444-8555-666666666666";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const ORDER_ID = "87654321-4321-4321-8321-210987654321";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DISK = awsResourceName("disk", DISK_ID);
const INSTANCE = awsResourceName("instance", INSTANCE_ID);
const SNAP = awsResourceName("snapshot", BACKUP_ID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const TAG = [{ key: "tc:resource", value: DISK_ID }];

const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

function view(over: Partial<ResourceView> & { id: string }): ResourceView {
  return {
    customerId: CID,
    family: "linux_instance",
    productId: null,
    parentResourceId: null,
    awsName: null,
    state: "active",
    config: {},
    ...over,
  };
}

const diskRow = view({
  id: DISK_ID,
  family: "disk",
  parentResourceId: INSTANCE_ID,
  state: "creating",
});
const instanceRow = view({ id: INSTANCE_ID });

function setup() {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({
    caller: "provisioner",
    clock,
    requestHandler: aws.handler,
  });
  const store = new Map<string, ResourceView>([[INSTANCE_ID, instanceRow]]);
  const marked: (number | null)[] = [];
  const deps: BackupDeps = {
    listBackups: async () => [{ id: BACKUP_ID }],
    ensureFinalBackup: async () => ({ id: BACKUP_ID }),
    markFinalBackup: async (input) => {
      marked.push(input.sizeGb);
    },
  };
  const adapter = createDiskAdapter(deps);
  const config = adapter.parseConfig({
    productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    region: "ap-southeast-1",
    displayName: "My Secret Data",
    sizeGb: 32,
  });
  const ctx = (
    step: string | null,
    kind: OpCtx<unknown>["operation"]["kind"],
    payload: unknown = { orderId: ORDER_ID },
    owned?: (id: string) => Promise<ResourceView | null>,
  ): OpCtx<typeof config> => ({
    operation: { id: OP_ID, kind, step, attempt: 1, createdAt: new Date(NOW), payload },
    stepKey: `${OP_ID}:${step ?? "start"}`,
    resource: diskRow,
    config,
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: owned ?? (async (id) => store.get(id) ?? null),
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls, store, marked };
}

describe("disk adapter: create", () => {
  it("creates the disk in the instance zone with a generated name (R11)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    aws.on("lightsail", "CreateDisk", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(ctx(null, "create"));
    expect(r).toMatchObject({ kind: "next", step: "wait_available", patch: { awsName: DISK } });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "CreateDisk")!.body);
    expect(sent.diskName).toBe(DISK);
    expect(sent.availabilityZone).toBe("ap-southeast-1a");
    expect(sent.sizeInGb).toBe(32);
    expect(sent.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: DISK_ID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: ORDER_ID },
      ]),
    );
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("My Secret Data");
  });

  it("a retry finds the disk and creates nothing (R7); a foreign disk is a conflict", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetDisk", lightsailOk({ disk: { name: DISK, tags: TAG } }));
    const r = await adapter.aws.create(ctx("create_disk", "create"));
    expect(r).toMatchObject({ kind: "next", step: "wait_available" });
    expect(calls()).toEqual(["GetDisk"]);
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, tags: [{ key: "tc:resource", value: "other" }] } }),
    );
    await expect(adapter.aws.create(ctx("create_disk", "create"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("waits while pending and is active when available", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "pending", tags: TAG } }),
      lightsailOk({ disk: { name: DISK, state: "available", tags: TAG } }),
    );
    expect(await adapter.aws.create(ctx("wait_available", "create"))).toMatchObject({
      kind: "wait",
      step: "wait_available",
    });
    expect(await adapter.aws.create(ctx("wait_available", "create"))).toEqual({
      kind: "done",
      patch: { state: "active", awsName: DISK },
    });
  });

  it("an error disk fails without raw AWS text, and the wait is bounded", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "error", tags: TAG } }),
    );
    const e = await adapter.aws.create(ctx("wait_available", "create")).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "upstream_unavailable" });
    expectNoLeak(e);
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "pending", tags: TAG } }),
    );
    const late = ctx("wait_available", "create");
    await expect(
      adapter.aws.create({
        ...late,
        operation: { ...late.operation, createdAt: new Date(NOW - 21 * 60 * 1000) },
      }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("parseConfig refuses a size outside the Lightsail range", () => {
    const { adapter } = setup();
    const ok = { productId: null, region: "ap-southeast-1", displayName: "d" };
    for (const sizeGb of [0, 7, 16385, 1.5, "32", undefined]) {
      expect(() => adapter.parseConfig({ ...ok, sizeGb })).toThrow();
    }
  });
});

describe("disk adapter: attach and detach", () => {
  it("attaches to the customer's own instance and records it", async () => {
    const { aws, adapter, ctx } = setup();
    const payload = { instanceId: INSTANCE_ID, diskPath: "/dev/xvdf" };
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
      lightsailOk({
        disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: INSTANCE, tags: TAG },
      }),
    );
    aws.on("lightsail", "AttachDisk", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload));
    expect(r1).toMatchObject({ kind: "wait", step: "wait_attached" });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "AttachDisk")!.body);
    expect(sent).toEqual({ diskName: DISK, instanceName: INSTANCE, diskPath: "/dev/xvdf" });
    const r2 = await adapter.aws.action(
      "attach_disk",
      ctx("wait_attached", "attach_disk", payload),
    );
    expect(r2).toEqual({
      kind: "done",
      patch: { configMerge: { attachedInstanceId: INSTANCE_ID, diskPath: "/dev/xvdf" } },
    });
  });

  it("a retry of the attach makes no second AttachDisk (R7); another instance is a conflict", async () => {
    const { aws, adapter, ctx, calls } = setup();
    const payload = { instanceId: INSTANCE_ID, diskPath: "/dev/xvdf" };
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({
        disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: INSTANCE, tags: TAG },
      }),
    );
    const r = await adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload));
    expect(r).toMatchObject({ kind: "wait", step: "wait_attached" });
    expect(calls()).toEqual(["GetDisk"]);
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({
        disk: {
          name: DISK,
          isAttached: true,
          attachedTo: "tc-instance-0000000000000000",
          tags: TAG,
        },
      }),
    );
    await expect(
      adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload)),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a payload that is not valid, and an instance ctx.owned does not return (R8)", async () => {
    const { aws, adapter, ctx } = setup();
    for (const payload of [
      {},
      { instanceId: "../x", diskPath: "/dev/xvdf" },
      { instanceId: INSTANCE_ID, diskPath: "/dev/sda" },
      { instanceId: INSTANCE_ID, diskPath: "/dev/xvdf; rm" },
      { instanceId: INSTANCE_ID },
    ]) {
      await expect(
        adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload)),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(
      adapter.aws.action(
        "attach_disk",
        ctx(
          null,
          "attach_disk",
          { instanceId: INSTANCE_ID, diskPath: "/dev/xvdf" },
          async () => null,
        ),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });

  it("refuses an instance of another family or a destroyed one", async () => {
    const { adapter, ctx, store } = setup();
    const payload = { instanceId: INSTANCE_ID, diskPath: "/dev/xvdf" };
    store.set(INSTANCE_ID, view({ id: INSTANCE_ID, family: "database" }));
    await expect(
      adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload)),
    ).rejects.toMatchObject({ code: "validation" });
    store.set(INSTANCE_ID, view({ id: INSTANCE_ID, state: "destroyed" }));
    await expect(
      adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload)),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("detaches, waits, and records that nothing is attached", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({
        disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: INSTANCE, tags: TAG },
      }),
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
    );
    aws.on("lightsail", "DetachDisk", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.action("detach_disk", ctx(null, "detach_disk"));
    expect(r1).toMatchObject({ kind: "wait", step: "wait_detached" });
    expect(JSON.parse(aws.seen.find((q) => q.action === "DetachDisk")!.body)).toEqual({
      diskName: DISK,
    });
    const r2 = await adapter.aws.action("detach_disk", ctx("wait_detached", "detach_disk"));
    expect(r2).toEqual({
      kind: "done",
      patch: { configMerge: { attachedInstanceId: null } },
    });
  });

  it("a detach of a detached disk is done", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
    );
    const r = await adapter.aws.action("detach_disk", ctx(null, "detach_disk"));
    expect(r).toEqual({ kind: "done", patch: { configMerge: { attachedInstanceId: null } } });
    expect(calls()).toEqual(["GetDisk"]);
  });
});

describe("disk adapter: final snapshot, destroy, purge", () => {
  it("final snapshot is a disk snapshot named from the child backup row (R13)", async () => {
    const { aws, adapter, ctx, marked } = setup();
    aws.on("lightsail", "GetDiskSnapshot", notFound());
    aws.on("lightsail", "CreateDiskSnapshot", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.finalSnapshot(ctx(null, "final_snapshot"));
    expect(r1).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    expect(JSON.parse(aws.seen.find((q) => q.action === "CreateDiskSnapshot")!.body)).toMatchObject(
      {
        diskName: DISK,
        diskSnapshotName: SNAP,
      },
    );
    aws.on(
      "lightsail",
      "GetDiskSnapshot",
      lightsailOk({
        diskSnapshot: {
          name: SNAP,
          state: "completed",
          sizeInGb: 32,
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
    );
    expect(await adapter.aws.finalSnapshot(ctx("wait_snapshot", "final_snapshot"))).toEqual({
      kind: "done",
    });
    expect(marked).toEqual([32]);
  });

  it("destroy detaches first when attached, then deletes; not found is done", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({
        disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: INSTANCE, tags: TAG },
      }),
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
    );
    aws.on("lightsail", "DetachDisk", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.destroy(ctx(null, "destroy"));
    expect(r1).toMatchObject({ kind: "wait", step: "wait_detached" });
    const r2 = await adapter.aws.destroy(ctx("wait_detached", "destroy"));
    expect(r2).toMatchObject({ kind: "next", step: "delete_disk" });
    aws.on("lightsail", "DeleteDisk", notFound());
    const r3 = await adapter.aws.destroy(ctx("delete_disk", "destroy"));
    expect(r3).toEqual({ kind: "done", patch: { state: "destroyed" } });
    expect(JSON.parse(aws.seen.find((q) => q.action === "DeleteDisk")!.body)).toEqual({
      diskName: DISK,
      forceDeleteAddOns: true,
    });
  });

  it("destroy of a disk that is gone skips to delete", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    expect(await adapter.aws.destroy(ctx(null, "destroy"))).toMatchObject({
      kind: "next",
      step: "delete_disk",
    });
  });

  it("purge deletes the disk snapshots of every child backup", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "DeleteDiskSnapshot", lightsailOk({ operations: [] }));
    expect(await adapter.aws.purgeSnapshots(ctx(null, "purge_snapshots"))).toEqual({
      kind: "done",
    });
    expect(JSON.parse(aws.seen.find((q) => q.action === "DeleteDiskSnapshot")!.body)).toEqual({
      diskSnapshotName: SNAP,
    });
  });

  it("suspend and resume leave the disk alone (it goes with the instance)", async () => {
    const { aws, adapter, ctx } = setup();
    expect(await adapter.aws.suspend(ctx(null, "suspend"))).toEqual({ kind: "done" });
    expect(await adapter.aws.resume(ctx(null, "resume"))).toEqual({ kind: "done" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });

  it("refuses an action kind it does not own (R16)", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.action("reboot", ctx(null, "reboot"))).rejects.toMatchObject({
      code: "validation",
    });
  });
});

describe("the whole cycle (WP5-T2 proof)", () => {
  it("create, attach, detach, destroy against one fake disk", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    aws.on("lightsail", "CreateDisk", lightsailOk({ operations: [] }));
    expect(await adapter.aws.create(ctx(null, "create"))).toMatchObject({ step: "wait_available" });
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "available", tags: TAG } }),
    );
    expect(await adapter.aws.create(ctx("wait_available", "create"))).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
    const payload = { instanceId: INSTANCE_ID, diskPath: "/dev/xvdg" };
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
    );
    aws.on("lightsail", "AttachDisk", lightsailOk({ operations: [] }));
    expect(
      await adapter.aws.action("attach_disk", ctx(null, "attach_disk", payload)),
    ).toMatchObject({
      step: "wait_attached",
    });
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({
        disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: INSTANCE, tags: TAG },
      }),
    );
    expect(
      await adapter.aws.action("attach_disk", ctx("wait_attached", "attach_disk", payload)),
    ).toMatchObject({ kind: "done" });
    aws.on("lightsail", "DetachDisk", lightsailOk({ operations: [] }));
    expect(await adapter.aws.action("detach_disk", ctx(null, "detach_disk"))).toMatchObject({
      step: "wait_detached",
    });
    aws.on(
      "lightsail",
      "GetDisk",
      lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } }),
    );
    expect(
      await adapter.aws.action("detach_disk", ctx("wait_detached", "detach_disk")),
    ).toMatchObject({
      kind: "done",
    });
    aws.on("lightsail", "DeleteDisk", lightsailOk({ operations: [] }));
    expect(await adapter.aws.destroy(ctx("delete_disk", "destroy"))).toEqual({
      kind: "done",
      patch: { state: "destroyed" },
    });
    const names = aws.seen.filter((q) => q.service === "lightsail").map((q) => q.action);
    expect(names.filter((n) => n === "CreateDisk")).toHaveLength(1);
    expect(names.filter((n) => n === "AttachDisk")).toHaveLength(1);
    expect(names.filter((n) => n === "DetachDisk")).toHaveLength(1);
    expect(names.filter((n) => n === "DeleteDisk")).toHaveLength(1);
  });
});
