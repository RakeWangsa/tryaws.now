import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBackupAdapter, withBackups, type BackupDeps } from "../adapters/backup";
import { createLinuxInstanceAdapter, type LinuxInstanceDeps } from "../adapters/linux-instance";
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
const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const BACKUP_ID = "22222222-3333-4444-8555-666666666666";
const NEW_ID = "33333333-4444-4555-8666-777777777777";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const ORDER_ID = "87654321-4321-4321-8321-210987654321";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const SNAP = awsResourceName("snapshot", BACKUP_ID);
const INSTANCE = awsResourceName("instance", INSTANCE_ID);
const NEW_INSTANCE = awsResourceName("instance", NEW_ID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

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

const instanceRow = view({ id: INSTANCE_ID, productId: PRODUCT, awsName: INSTANCE });
const backupRow = view({
  id: BACKUP_ID,
  family: "backup",
  parentResourceId: INSTANCE_ID,
  awsName: SNAP,
  state: "active",
});

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
  const store = new Map<string, ResourceView>([
    [INSTANCE_ID, instanceRow],
    [BACKUP_ID, backupRow],
  ]);
  const finals: { id: string; marked: number | null | undefined; ensured: number }[] = [];
  const deps: BackupDeps = {
    listBackups: async () => [{ id: BACKUP_ID }],
    ensureFinalBackup: async () => {
      if (finals.length === 0) finals.push({ id: BACKUP_ID, marked: undefined, ensured: 0 });
      (finals[0] as { ensured: number }).ensured += 1;
      return { id: BACKUP_ID };
    },
    markFinalBackup: async (input) => {
      (finals[0] as { marked: number | null }).marked = input.sizeGb;
    },
  };
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  function ctxFor<C>(
    resource: ResourceView,
    config: C,
    step: string | null,
    kind: OpCtx<C>["operation"]["kind"],
    payload: unknown = {},
    owned?: (id: string) => Promise<ResourceView | null>,
  ): OpCtx<C> {
    return {
      operation: {
        id: OP_ID,
        kind,
        step,
        attempt: 1,
        createdAt: new Date(NOW),
        payload,
      },
      stepKey: `${OP_ID}:${step ?? "start"}`,
      resource,
      config,
      account: POOL,
      region: "ap-southeast-1",
      access,
      env: "staging",
      clock,
      owned: owned ?? (async (id) => store.get(id) ?? null),
    };
  }
  return { aws, deps, calls, ctxFor, store, finals };
}

describe("backup adapter: create_backup", () => {
  it("snapshots the parent instance with a generated name and waits (R11)", async () => {
    const { aws, ctxFor, calls } = setup();
    const adapter = createBackupAdapter();
    const config = adapter.parseConfig({ displayName: "Before the upgrade" });
    aws.on("lightsail", "GetInstanceSnapshot", notFound());
    aws.on("lightsail", "CreateInstanceSnapshot", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action(
      "create_backup",
      ctxFor(backupRow, config, null, "create_backup", { orderId: ORDER_ID }),
    );
    expect(r).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "CreateInstanceSnapshot")!.body);
    expect(sent.instanceName).toBe(INSTANCE);
    expect(sent.instanceSnapshotName).toBe(SNAP);
    expect(sent.tags).toEqual(expect.arrayContaining([{ key: "tc:resource", value: BACKUP_ID }]));
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("Before the upgrade");
    expect(calls()).toEqual(["GetInstanceSnapshot", "CreateInstanceSnapshot"]);
  });

  it("a retry finds the snapshot and creates nothing, then completes when available (R7)", async () => {
    const { aws, ctxFor, calls } = setup();
    const adapter = createBackupAdapter();
    const config = adapter.parseConfig({});
    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "pending",
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "available",
          sizeInGb: 20,
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
    );
    const again = await adapter.aws.action(
      "create_backup",
      ctxFor(backupRow, config, "wait_snapshot", "create_backup"),
    );
    expect(again).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    const done = await adapter.aws.action(
      "create_backup",
      ctxFor(backupRow, config, "wait_snapshot", "create_backup"),
    );
    expect(done).toEqual({
      kind: "done",
      patch: { state: "active", awsName: SNAP, configMerge: { sizeGb: 20 } },
    });
    expect(calls()).not.toContain("CreateInstanceSnapshot");
  });

  it("refuses a parent that ctx.owned does not return (R8) and one that is a stranger's snapshot", async () => {
    const { aws, ctxFor } = setup();
    const adapter = createBackupAdapter();
    const config = adapter.parseConfig({});
    await expect(
      adapter.aws.action(
        "create_backup",
        ctxFor(backupRow, config, null, "create_backup", {}, async () => null),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);

    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "available",
          tags: [{ key: "tc:resource", value: "other" }],
        },
      }),
    );
    await expect(
      adapter.aws.action("create_backup", ctxFor(backupRow, config, null, "create_backup")),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("an error snapshot fails without raw AWS text", async () => {
    const { aws, ctxFor } = setup();
    const adapter = createBackupAdapter();
    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "error",
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
    );
    const error = await adapter.aws
      .action(
        "create_backup",
        ctxFor(backupRow, adapter.parseConfig({}), "wait_snapshot", "create_backup"),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "upstream_unavailable" });
    expectNoLeak(error);
  });

  it("refuses kinds it does not own (R16)", async () => {
    const { ctxFor } = setup();
    const adapter = createBackupAdapter();
    await expect(
      adapter.aws.action("reboot", ctxFor(backupRow, adapter.parseConfig({}), null, "reboot")),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("backup adapter: delete_backup", () => {
  it("deletes the snapshot by its generated name; not found is done", async () => {
    const { aws, ctxFor } = setup();
    const adapter = createBackupAdapter();
    aws.on("lightsail", "DeleteInstanceSnapshot", notFound());
    const r = await adapter.aws.action(
      "delete_backup",
      ctxFor(backupRow, adapter.parseConfig({}), null, "delete_backup"),
    );
    expect(r).toEqual({ kind: "done", patch: { state: "destroyed" } });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "DeleteInstanceSnapshot")!.body);
    expect(sent).toEqual({ instanceSnapshotName: SNAP });
  });

  it("uses the disk snapshot call when the parent is a disk", async () => {
    const { aws, ctxFor, store } = setup();
    const diskId = "44444444-5555-4666-8777-888888888888";
    store.set(diskId, view({ id: diskId, family: "disk" }));
    const adapter = createBackupAdapter();
    aws.on("lightsail", "DeleteDiskSnapshot", lightsailOk({ operations: [] }));
    await adapter.aws.action(
      "delete_backup",
      ctxFor(
        { ...backupRow, parentResourceId: diskId },
        adapter.parseConfig({}),
        null,
        "delete_backup",
      ),
    );
    expect(aws.seen.some((q) => q.action === "DeleteDiskSnapshot")).toBe(true);
  });
});

function withLinux() {
  const s = setup();
  const linuxDeps: LinuxInstanceDeps = {
    loadLaunch: async () => ({
      bundleId: "nano_3_0",
      blueprintId: "ubuntu_24_04",
      publicKey: null,
    }),
    vpcCidr: async () => "172.26.0.0/16",
    bootstrapMarker: async () => "present",
  };
  const adapter = withBackups(createLinuxInstanceAdapter(linuxDeps), s.deps, linuxDeps);
  const config = adapter.parseConfig({
    productId: PRODUCT,
    region: "ap-southeast-1",
    displayName: "Restored",
    keyPairId: null,
  });
  const newRow = view({ id: NEW_ID, productId: PRODUCT, state: "creating" });
  return { ...s, adapter, config, newRow };
}

describe("restore to a new server (WP5-T1 proof)", () => {
  it("creates the instance from the snapshot, waits, then runs the linux steps", async () => {
    const { aws, adapter, config, newRow, ctxFor, calls } = withLinux();
    const payload = { orderId: ORDER_ID, restoreFromBackupId: BACKUP_ID };
    aws.on("lightsail", "GetInstance", notFound());
    aws.on("lightsail", "CreateInstancesFromSnapshot", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.create(ctxFor(newRow, config, null, "create", payload));
    expect(r1).toMatchObject({
      kind: "next",
      step: "wait_restored",
      patch: { awsName: NEW_INSTANCE },
    });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "CreateInstancesFromSnapshot")!.body);
    expect(sent.instanceNames).toEqual([NEW_INSTANCE]);
    expect(sent.instanceSnapshotName).toBe(SNAP);
    expect(sent.bundleId).toBe("nano_3_0");
    expect(sent.availabilityZone).toBe("ap-southeast-1a");
    expect(sent.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: NEW_ID },
        { key: "tc:order", value: ORDER_ID },
        { key: "tc:os", value: "linux" },
      ]),
    );
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("Restored");

    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({
        instance: {
          name: NEW_INSTANCE,
          publicIpAddress: "52.220.10.20",
          state: { name: "running" },
        },
      }),
    );
    const r2 = await adapter.aws.create(ctxFor(newRow, config, "wait_restored", "create", payload));
    expect(r2).toMatchObject({ kind: "next", step: "verify_bootstrap" });
    const r3 = await adapter.aws.create(
      ctxFor(newRow, config, "verify_bootstrap", "create", payload),
    );
    expect(r3).toMatchObject({ kind: "next", step: "allocate_ip" });
    expect(calls()).not.toContain("ImportKeyPair");
  });

  it("a retried restore_instance makes one instance (R7); a foreign one is a conflict", async () => {
    const { aws, adapter, config, newRow, ctxFor, calls } = withLinux();
    const payload = { orderId: ORDER_ID, restoreFromBackupId: BACKUP_ID };
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({
        instance: { name: NEW_INSTANCE, tags: [{ key: "tc:resource", value: NEW_ID }] },
      }),
    );
    const r = await adapter.aws.create(
      ctxFor(newRow, config, "restore_instance", "create", payload),
    );
    expect(r).toMatchObject({ kind: "next", step: "wait_restored" });
    expect(calls()).toEqual(["GetInstance"]);
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: NEW_INSTANCE, tags: [{ key: "tc:resource", value: "x" }] } }),
    );
    await expect(
      adapter.aws.create(ctxFor(newRow, config, "restore_instance", "create", payload)),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a backup of another customer, a pending one, and a backup of a disk (R8, R16)", async () => {
    const { aws, adapter, config, newRow, ctxFor, store } = withLinux();
    const payload = { orderId: ORDER_ID, restoreFromBackupId: BACKUP_ID };
    await expect(
      adapter.aws.create(ctxFor(newRow, config, null, "create", payload, async () => null)),
    ).rejects.toMatchObject({ code: "validation" });
    store.set(BACKUP_ID, { ...backupRow, state: "creating" });
    await expect(
      adapter.aws.create(ctxFor(newRow, config, null, "create", payload)),
    ).rejects.toMatchObject({
      code: "validation",
    });
    store.set(BACKUP_ID, backupRow);
    store.set(INSTANCE_ID, view({ id: INSTANCE_ID, family: "disk" }));
    await expect(
      adapter.aws.create(ctxFor(newRow, config, null, "create", payload)),
    ).rejects.toMatchObject({
      code: "validation",
    });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });

  it("a restore payload with a bad backup id is refused before AWS", async () => {
    const { aws, adapter, config, newRow, ctxFor } = withLinux();
    await expect(
      adapter.aws.create(
        ctxFor(newRow, config, null, "create", { orderId: ORDER_ID, restoreFromBackupId: "../x" }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });

  it("a plain create without restoreFromBackupId still goes to the linux steps", async () => {
    const { aws, adapter, newRow, ctxFor } = withLinux();
    const config = adapter.parseConfig({
      productId: PRODUCT,
      region: "ap-southeast-1",
      displayName: "x",
      keyPairId: null,
    });
    await expect(
      adapter.aws.create(ctxFor(newRow, config, null, "create", { orderId: ORDER_ID })),
    ).rejects.toMatchObject({ code: "validation" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });
});

describe("automatic backups (set_auto_backup)", () => {
  it("enables the AutoSnapshot add-on at an hourly time and saves it in the config", async () => {
    const { aws, adapter, config, ctxFor } = withLinux();
    aws.on("lightsail", "EnableAddOn", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action(
      "set_auto_backup",
      ctxFor(instanceRow, config, null, "set_auto_backup", { enabled: true, hour: "06:00" }),
    );
    expect(r).toEqual({
      kind: "done",
      patch: { configMerge: { autoBackup: { enabled: true, hour: "06:00" } } },
    });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "EnableAddOn")!.body);
    expect(sent).toEqual({
      resourceName: INSTANCE,
      addOnRequest: {
        addOnType: "AutoSnapshot",
        autoSnapshotAddOnRequest: { snapshotTimeOfDay: "06:00" },
      },
    });
  });

  it("disables it", async () => {
    const { aws, adapter, config, ctxFor } = withLinux();
    aws.on("lightsail", "DisableAddOn", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action(
      "set_auto_backup",
      ctxFor(instanceRow, config, null, "set_auto_backup", { enabled: false }),
    );
    expect(r).toEqual({ kind: "done", patch: { configMerge: { autoBackup: { enabled: false } } } });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "DisableAddOn")!.body);
    expect(sent).toEqual({ resourceName: INSTANCE, addOnType: "AutoSnapshot" });
  });

  it("refuses a bad hour and a Windows instance before AWS (R16)", async () => {
    const { aws, adapter, config, ctxFor } = withLinux();
    for (const hour of ["6:00", "06:30", "24:00", 6, undefined, "06:00; drop"]) {
      await expect(
        adapter.aws.action(
          "set_auto_backup",
          ctxFor(instanceRow, config, null, "set_auto_backup", { enabled: true, hour }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(
      adapter.aws.action(
        "set_auto_backup",
        ctxFor({ ...instanceRow, family: "windows_instance" }, config, null, "set_auto_backup", {
          enabled: true,
          hour: "06:00",
        }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(aws.seen.filter((q) => q.service === "lightsail")).toHaveLength(0);
  });

  it("other actions still reach the linux adapter", async () => {
    const { aws, adapter, config, ctxFor } = withLinux();
    aws.on("lightsail", "RebootInstance", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action("reboot", ctxFor(instanceRow, config, null, "reboot"));
    expect(r).toEqual({ kind: "done" });
  });
});

describe("final snapshot and purge (R13)", () => {
  it("makes the child backup row first and names the snapshot from the child id", async () => {
    const { aws, adapter, config, ctxFor, finals } = withLinux();
    aws.on("lightsail", "GetInstanceSnapshot", notFound());
    aws.on("lightsail", "CreateInstanceSnapshot", lightsailOk({ operations: [] }));
    const r = await adapter.aws.finalSnapshot(ctxFor(instanceRow, config, null, "final_snapshot"));
    expect(r).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "CreateInstanceSnapshot")!.body);
    expect(sent.instanceName).toBe(INSTANCE);
    expect(sent.instanceSnapshotName).toBe(SNAP);
    expect(finals[0]?.ensured).toBe(1);
    expect(finals[0]?.marked).toBeUndefined();
  });

  it("marks the child backup active only when AWS says available", async () => {
    const { aws, adapter, config, ctxFor, finals } = withLinux();
    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "pending",
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
      lightsailOk({
        instanceSnapshot: {
          name: SNAP,
          state: "available",
          sizeInGb: 40,
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
    );
    const wait = await adapter.aws.finalSnapshot(
      ctxFor(instanceRow, config, "wait_snapshot", "final_snapshot"),
    );
    expect(wait).toMatchObject({ kind: "wait" });
    expect(finals[0]?.marked).toBeUndefined();
    const done = await adapter.aws.finalSnapshot(
      ctxFor(instanceRow, config, "wait_snapshot", "final_snapshot"),
    );
    expect(done).toEqual({ kind: "done" });
    expect(finals[0]?.marked).toBe(40);
  });

  it("purge deletes every child backup; not found is done", async () => {
    const { aws, adapter, config, ctxFor } = withLinux();
    aws.on("lightsail", "DeleteInstanceSnapshot", notFound());
    const r = await adapter.aws.purgeSnapshots(
      ctxFor(instanceRow, config, null, "purge_snapshots"),
    );
    expect(r).toEqual({ kind: "done" });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "DeleteInstanceSnapshot")!.body);
    expect(sent).toEqual({ instanceSnapshotName: SNAP });
  });
});
