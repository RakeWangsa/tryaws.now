import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBackupAdapter } from "../adapters/backup";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-G9. A manual snapshot of a database is a child `backup` row like the one of a server: the
// backup adapter takes it with the Lightsail relational database snapshot calls, with a generated name.
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DB_ID = "11111111-2222-4333-8444-555555555555";
const BACKUP_ID = "22222222-3333-4444-8555-666666666666";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const SNAP = awsResourceName("snapshot", BACKUP_ID);
const DB = awsResourceName("database", DB_ID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

const view = (over: Partial<ResourceView> & { id: string }): ResourceView => ({
  customerId: CID,
  family: "database",
  productId: null,
  parentResourceId: null,
  awsName: null,
  state: "active",
  config: {},
  ...over,
});
const dbRow = view({ id: DB_ID, awsName: DB });
const backupRow = view({
  id: BACKUP_ID,
  family: "backup",
  parentResourceId: DB_ID,
  awsName: SNAP,
  state: "creating",
});

function setup(parent: ResourceView = dbRow) {
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
  const adapter = createBackupAdapter();
  const ctx = (kind: "create_backup" | "delete_backup", step: string | null = null) =>
    ({
      operation: { id: OP_ID, kind, step, attempt: 1, createdAt: new Date(NOW), payload: {} },
      stepKey: `${OP_ID}:${step ?? "start"}`,
      resource: backupRow,
      config: adapter.parseConfig({ displayName: "Before the migration" }),
      account: POOL,
      region: "ap-southeast-1",
      access,
      env: "staging",
      clock,
      owned: async (id: string) => (id === parent.id ? parent : null),
    }) as OpCtx<ReturnType<typeof adapter.parseConfig>>;
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls };
}

describe("backup adapter, database parent", () => {
  it("snapshots the database with a generated name and waits (R11)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetRelationalDatabaseSnapshot", notFound());
    aws.on("lightsail", "CreateRelationalDatabaseSnapshot", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action("create_backup", ctx("create_backup"));
    expect(r).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    const sent = JSON.parse(
      aws.seen.find((q) => q.action === "CreateRelationalDatabaseSnapshot")!.body,
    );
    expect(sent.relationalDatabaseName).toBe(DB);
    expect(sent.relationalDatabaseSnapshotName).toBe(SNAP);
    expect(sent.tags).toEqual(expect.arrayContaining([{ key: "tc:resource", value: BACKUP_ID }]));
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("Before the migration");
    expect(calls()).toEqual(["GetRelationalDatabaseSnapshot", "CreateRelationalDatabaseSnapshot"]);
  });

  it("completes with the stored size when the snapshot is available, and a retry makes none (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabaseSnapshot",
      lightsailOk({
        relationalDatabaseSnapshot: {
          name: SNAP,
          state: "available",
          sizeInGb: 40,
          tags: [{ key: "tc:resource", value: BACKUP_ID }],
        },
      }),
    );
    const r = await adapter.aws.action("create_backup", ctx("create_backup", "wait_snapshot"));
    expect(r).toMatchObject({
      kind: "done",
      patch: { state: "active", awsName: SNAP, configMerge: { sizeGb: 40 } },
    });
    expect(calls()).toEqual(["GetRelationalDatabaseSnapshot"]);
  });

  it("a snapshot of that name that is not ours is a conflict (R16)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabaseSnapshot",
      lightsailOk({ relationalDatabaseSnapshot: { name: SNAP, state: "available", tags: [] } }),
    );
    await expect(adapter.aws.action("create_backup", ctx("create_backup"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("a stopped database cannot be snapshotted", async () => {
    const { adapter, ctx } = setup(view({ id: DB_ID, awsName: DB, state: "stopped" }));
    await expect(adapter.aws.action("create_backup", ctx("create_backup"))).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("delete removes only the snapshot of that name and ignores a missing one", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "DeleteRelationalDatabaseSnapshot", notFound());
    const r = await adapter.aws.action("delete_backup", ctx("delete_backup"));
    expect(r).toMatchObject({ kind: "done", patch: { state: "destroyed" } });
    const sent = JSON.parse(
      aws.seen.find((q) => q.action === "DeleteRelationalDatabaseSnapshot")!.body,
    );
    expect(sent.relationalDatabaseSnapshotName).toBe(SNAP);
  });

  it("another customer's database is nothing (R8)", async () => {
    const { adapter, ctx } = setup();
    const foreign = { ...ctx("create_backup"), owned: async () => null };
    await expect(adapter.aws.action("create_backup", foreign)).rejects.toMatchObject({
      code: "validation",
    });
  });
});
