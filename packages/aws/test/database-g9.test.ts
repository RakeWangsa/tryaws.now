import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createDatabaseAdapter } from "../adapters/database";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-G9. The database adapter: connection facts written back, the restore from a snapshot and from a
// point in time (both a NEW database), the maintenance window, and nothing that leaks a password.
const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const BID = "99999999-8888-4777-8666-555555555555";
const SRC = "77777777-6666-4555-8444-333333333333";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DB = awsResourceName("database", RID);
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const clock = { now: () => new Date(NOW) };
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

const row = (over: Partial<ResourceView> & { id: string }): ResourceView => ({
  customerId: CID,
  family: "database",
  productId: null,
  parentResourceId: null,
  awsName: null,
  state: "active",
  config: {},
  ...over,
});
const snapshotRow = (over: Partial<ResourceView> = {}) =>
  row({ id: BID, family: "backup", parentResourceId: SRC, ...over });

function setup(
  owned: (id: string) => Promise<ResourceView | null> = async () => null,
  config: Record<string, unknown> = {},
) {
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
  const adapter = createDatabaseAdapter({
    loadLaunch: async () => ({ bundleId: "micro_2_0", blueprintId: "postgres_16" }),
  });
  const ctx = (
    step: string | null,
    extra: { payload?: unknown; kind?: OperationKind; state?: string } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: extra.kind ?? "create",
      step,
      attempt: 1,
      createdAt: new Date(NOW),
      payload: extra.payload ?? { orderId: OID },
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: row({ id: RID, state: extra.state ?? "creating", config }),
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "Orders DB",
    }),
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  const bodyOf = (action: string) => JSON.parse(aws.seen.find((r) => r.action === action)!.body);
  return { aws, adapter, ctx, calls, bodyOf };
}

describe("connection facts", () => {
  it("writes the endpoint, the port and the master user name when the database is available", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabase",
      lightsailOk({
        relationalDatabase: {
          name: DB,
          state: "available",
          masterUsername: "tcadmin",
          masterEndpoint: {
            address: "ls-abc.cluster.ap-southeast-1.rds.amazonaws.com",
            port: 5432,
          },
          backupRetentionEnabled: true,
          tags: [{ key: "tc:resource", value: RID }],
        },
      }),
    );
    const r = await adapter.aws.create(ctx("wait_available"));
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        state: "active",
        configMerge: {
          endpointAddress: "ls-abc.cluster.ap-southeast-1.rds.amazonaws.com",
          endpointPort: 5432,
          masterUsername: "tcadmin",
        },
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/pass/i);
  });

  it("an endpoint that is not a plain host name or port is not stored (R16)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabase",
      lightsailOk({
        relationalDatabase: {
          name: DB,
          state: "available",
          masterEndpoint: { address: "evil host; <b>", port: 99999 },
          tags: [{ key: "tc:resource", value: RID }],
        },
      }),
    );
    const r = await adapter.aws.create(ctx("wait_available"));
    expect(r).toMatchObject({ kind: "done", patch: { state: "active" } });
    expect(JSON.stringify(r)).not.toContain("evil");
    expect(
      (r as { patch: { configMerge?: Record<string, unknown> } }).patch.configMerge ?? {},
    ).toEqual({});
  });
});

describe("restore to a new database", () => {
  it("from a snapshot of the customer's own database: FromSnapshot with generated names", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(async (id) =>
      id === BID ? snapshotRow() : id === SRC ? row({ id: SRC }) : null,
    );
    aws.on("lightsail", "GetRelationalDatabase", notFound());
    aws.on("lightsail", "CreateRelationalDatabaseFromSnapshot", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(
      ctx(null, { payload: { orderId: OID, restoreFromBackupId: BID } }),
    );
    expect(r).toMatchObject({ kind: "next", step: "wait_available", patch: { awsName: DB } });
    const body = bodyOf("CreateRelationalDatabaseFromSnapshot");
    expect(body).toMatchObject({
      relationalDatabaseName: DB,
      relationalDatabaseSnapshotName: awsResourceName("snapshot", BID),
      relationalDatabaseBundleId: "micro_2_0",
      publiclyAccessible: false,
    });
    expect(body.tags).toEqual(expect.arrayContaining([{ key: "tc:resource", value: RID }]));
    expect(body.restoreTime).toBeUndefined();
    expect(aws.seen.map((q) => q.body).join("\n")).not.toContain("Orders DB");
  });

  it("from a point in time of the customer's own database", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(async (id) =>
      id === SRC ? row({ id: SRC }) : null,
    );
    aws.on("lightsail", "GetRelationalDatabase", notFound());
    aws.on("lightsail", "CreateRelationalDatabaseFromSnapshot", lightsailOk({ operations: [] }));
    const at = "2026-11-10T09:00:00.000Z";
    await adapter.aws.create(
      ctx(null, { payload: { orderId: OID, restoreSourceId: SRC, restoreTime: at } }),
    );
    const body = bodyOf("CreateRelationalDatabaseFromSnapshot");
    expect(body.sourceRelationalDatabaseName).toBe(awsResourceName("database", SRC));
    expect(body.restoreTime).toBe(Date.parse(at) / 1000);
    expect(body.useLatestRestorableTime).toBeUndefined();
    expect(body.relationalDatabaseSnapshotName).toBeUndefined();
  });

  it("refuses a time outside the seven-day window, a bad time and a source that is not ours (R8, R16)", async () => {
    const cases: [Record<string, unknown>, (id: string) => Promise<ResourceView | null>][] = [
      [
        { restoreSourceId: SRC, restoreTime: "2026-10-01T00:00:00.000Z" },
        async () => row({ id: SRC }),
      ],
      [
        { restoreSourceId: SRC, restoreTime: "2026-11-12T11:58:00.000Z" },
        async () => row({ id: SRC }),
      ],
      [{ restoreSourceId: SRC, restoreTime: "soon" }, async () => row({ id: SRC })],
      [{ restoreSourceId: SRC, restoreTime: "2026-11-10T09:00:00.000Z" }, async () => null],
      [
        { restoreSourceId: SRC, restoreTime: "2026-11-10T09:00:00.000Z" },
        async () => row({ id: SRC, customerId: "other" }),
      ],
      [
        { restoreSourceId: SRC, restoreTime: "2026-11-10T09:00:00.000Z" },
        async () => row({ id: SRC, family: "disk" }),
      ],
      [{ restoreFromBackupId: BID }, async () => null],
      [{ restoreFromBackupId: BID }, async () => snapshotRow({ state: "creating" })],
      [{ restoreFromBackupId: "not-a-uuid" }, async () => snapshotRow()],
    ];
    for (const [extra, owned] of cases) {
      const s = setup(owned);
      s.aws.on("lightsail", "GetRelationalDatabase", notFound());
      await expect(s.adapter.aws.create(ctx0(s, { orderId: OID, ...extra }))).rejects.toMatchObject(
        { code: "validation" },
      );
      expect(s.calls()).not.toContain("CreateRelationalDatabaseFromSnapshot");
    }
  });

  it("a retried restore finds its database and makes none (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup(async (id) =>
      id === BID ? snapshotRow() : row({ id }),
    );
    aws.on(
      "lightsail",
      "GetRelationalDatabase",
      lightsailOk({
        relationalDatabase: {
          name: DB,
          state: "creating",
          tags: [{ key: "tc:resource", value: RID }],
        },
      }),
    );
    const r = await adapter.aws.create(
      ctx("create_database", { payload: { orderId: OID, restoreFromBackupId: BID } }),
    );
    expect(r).toMatchObject({ kind: "next", step: "wait_available" });
    expect(calls()).not.toContain("CreateRelationalDatabaseFromSnapshot");
  });
});

function ctx0(s: ReturnType<typeof setup>, payload: unknown) {
  return s.ctx(null, { payload });
}

describe("maintenance window", () => {
  it("sets the preferred maintenance window and keeps it in the config", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(undefined, { backupWindow: "03:00-04:00" });
    aws.on("lightsail", "UpdateRelationalDatabase", lightsailOk({ operations: [] }));
    const r = await adapter.aws.action(
      "set_db_options",
      ctx(null, {
        kind: "set_db_options",
        state: "active",
        payload: { maintenanceWindow: "tue:17:00-tue:17:30" },
      }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { maintenanceWindow: "tue:17:00-tue:17:30" } },
    });
    expect(bodyOf("UpdateRelationalDatabase")).toMatchObject({
      relationalDatabaseName: DB,
      preferredMaintenanceWindow: "tue:17:00-tue:17:30",
    });
  });

  it("refuses a bad window and one that overlaps the stored backup window", async () => {
    for (const payload of [
      { maintenanceWindow: "tue:17:00-tue:17:10" },
      { maintenanceWindow: "whenever" },
      { maintenanceWindow: "tue:03:30-tue:04:30" },
    ]) {
      const s = setup(undefined, { backupWindow: "03:00-04:00" });
      await expect(
        s.adapter.aws.action(
          "set_db_options",
          s.ctx(null, { kind: "set_db_options", state: "active", payload }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
      expect(s.calls()).toEqual([]);
    }
  });
});
