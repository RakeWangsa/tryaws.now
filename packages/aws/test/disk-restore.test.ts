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

// WPU-B5 item 26: a `create` of a disk whose payload names a snapshot (a backup row) of a disk of the
// customer runs CreateDiskFromSnapshot. The names are generated (R11), the rows are the customer's own
// (R8), a retry creates nothing twice (R7).
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DISK_ID = "44444444-5555-4666-8777-888888888888";
const SOURCE_ID = "99999999-5555-4666-8777-888888888888";
const BACKUP_ID = "22222222-3333-4444-8555-666666666666";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const ORDER_ID = "87654321-4321-4321-8321-210987654321";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DISK = awsResourceName("disk", DISK_ID);
const SNAP = awsResourceName("snapshot", BACKUP_ID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const TAG = [{ key: "tc:resource", value: DISK_ID }];
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

function view(over: Partial<ResourceView> & { id: string }): ResourceView {
  return {
    customerId: CID,
    family: "disk",
    productId: null,
    parentResourceId: null,
    awsName: null,
    state: "active",
    config: {},
    ...over,
  };
}

function setup(sizeGb = 64) {
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
    [SOURCE_ID, view({ id: SOURCE_ID, config: { sizeGb: 32 } })],
    [
      BACKUP_ID,
      view({ id: BACKUP_ID, family: "backup", parentResourceId: SOURCE_ID, state: "active" }),
    ],
  ]);
  const deps: BackupDeps = {
    listBackups: async () => [],
    ensureFinalBackup: async () => ({ id: BACKUP_ID }),
    markFinalBackup: async () => undefined,
  };
  const adapter = createDiskAdapter(deps);
  const config = adapter.parseConfig({
    productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    region: "ap-southeast-1",
    displayName: "My Secret Data",
    sizeGb,
    restoreFromBackupId: BACKUP_ID,
  });
  const ctx = (
    step: string | null,
    payload: unknown = { orderId: ORDER_ID, restoreFromBackupId: BACKUP_ID },
    owned?: (id: string) => Promise<ResourceView | null>,
  ): OpCtx<typeof config> => ({
    operation: { id: OP_ID, kind: "create", step, attempt: 1, createdAt: new Date(NOW), payload },
    stepKey: `${OP_ID}:${step ?? "start"}`,
    resource: view({ id: DISK_ID, state: "creating" }),
    config,
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: owned ?? (async (id) => store.get(id) ?? null),
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls, store };
}

describe("disk adapter: create from a snapshot", () => {
  it("calls CreateDiskFromSnapshot with generated names, the snapshot of the backup row and our tags (R11)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    aws.on("lightsail", "CreateDiskFromSnapshot", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_available", patch: { awsName: DISK } });
    const sent = JSON.parse(aws.seen.find((q) => q.action === "CreateDiskFromSnapshot")!.body);
    expect(sent).toMatchObject({
      diskName: DISK,
      diskSnapshotName: SNAP,
      availabilityZone: "ap-southeast-1a",
      sizeInGb: 64,
    });
    // The two ways are exclusive in the API: only the snapshot name is sent.
    expect(sent).not.toHaveProperty("sourceDiskName");
    expect(sent.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: DISK_ID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: ORDER_ID },
      ]),
    );
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("My Secret Data");
    expect(aws.seen.some((q) => q.action === "CreateDisk")).toBe(false);
  });

  it("a retry finds our disk and creates nothing (R7); a foreign disk is a conflict", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetDisk", lightsailOk({ disk: { name: DISK, tags: TAG } }));
    expect(await adapter.aws.create(ctx("create_disk"))).toMatchObject({
      kind: "next",
      step: "wait_available",
    });
    expect(calls()).toEqual(["GetDisk"]);
    aws.on("lightsail", "GetDisk", lightsailOk({ disk: { name: DISK, tags: [] } }));
    await expect(adapter.aws.create(ctx("create_disk"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("the size of a disk of the same size as the source is allowed", async () => {
    const { aws, adapter, ctx } = setup(32);
    aws.on("lightsail", "GetDisk", notFound());
    aws.on("lightsail", "CreateDiskFromSnapshot", lightsailOk({ operations: [] }));
    expect(await adapter.aws.create(ctx(null))).toMatchObject({ kind: "next" });
  });

  it("refuses, before any AWS write, a snapshot that is another customer's or missing (R8)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    await expect(adapter.aws.create(ctx(null, undefined, async () => null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(aws.seen.some((q) => q.action === "CreateDiskFromSnapshot")).toBe(false);
  });

  it("refuses a snapshot that is not an active backup of a disk, and a disk smaller than the source (R16)", async () => {
    const bad: ((s: Map<string, ResourceView>) => void)[] = [
      (s) => s.set(BACKUP_ID, view({ id: BACKUP_ID, family: "disk", parentResourceId: SOURCE_ID })),
      (s) =>
        s.set(
          BACKUP_ID,
          view({ id: BACKUP_ID, family: "backup", parentResourceId: SOURCE_ID, state: "creating" }),
        ),
      (s) => s.set(BACKUP_ID, view({ id: BACKUP_ID, family: "backup", state: "active" })),
      (s) =>
        s.set(SOURCE_ID, view({ id: SOURCE_ID, family: "linux_instance", config: { sizeGb: 8 } })),
      (s) => s.set(SOURCE_ID, view({ id: SOURCE_ID, config: { sizeGb: 128 } })),
      (s) => s.set(SOURCE_ID, view({ id: SOURCE_ID, config: {} })),
    ];
    for (const change of bad) {
      const { aws, adapter, ctx, store } = setup();
      change(store);
      aws.on("lightsail", "GetDisk", notFound());
      await expect(adapter.aws.create(ctx(null))).rejects.toMatchObject({ code: "validation" });
      expect(aws.seen.some((q) => q.action === "CreateDiskFromSnapshot")).toBe(false);
    }
  });

  it("refuses a payload id that is not a uuid", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    await expect(
      adapter.aws.create(ctx(null, { orderId: ORDER_ID, restoreFromBackupId: "tc-snapshot-x" })),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("an AWS error leaks nothing", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    aws.on(
      "lightsail",
      "CreateDiskFromSnapshot",
      lightsailError(400, "InvalidInputException", "raw 210987654321"),
    );
    const error = await adapter.aws.create(ctx(null)).catch((e: unknown) => e);
    expectNoLeak(error);
  });

  it("a create without a snapshot in its payload is the plain CreateDisk as before", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", notFound());
    aws.on("lightsail", "CreateDisk", lightsailOk({ operations: [] }));
    await adapter.aws.create(ctx(null, { orderId: ORDER_ID }));
    expect(aws.seen.some((q) => q.action === "CreateDiskFromSnapshot")).toBe(false);
    expect(aws.seen.some((q) => q.action === "CreateDisk")).toBe(true);
  });
});
