import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createDatabaseAdapter, type DatabaseDeps } from "../adapters/database";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const BID = "99999999-8888-4777-8666-555555555555";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DB = awsResourceName("database", RID);
const SNAP = awsResourceName("snapshot", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

const backupRow = (over: Partial<ResourceView> = {}): ResourceView => ({
  id: BID,
  customerId: CID,
  family: "backup",
  productId: null,
  parentResourceId: RID,
  awsName: null,
  state: "active",
  config: {},
  ...over,
});

function setup(owned: (id: string) => Promise<ResourceView | null> = async () => null) {
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
  const deps: DatabaseDeps = {
    loadLaunch: async () => ({ bundleId: "micro_2_0", blueprintId: "postgres_16" }),
  };
  const adapter = createDatabaseAdapter(deps);
  const ctx = (
    step: string | null,
    extra: { payload?: unknown; kind?: OperationKind; createdAt?: Date } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: extra.kind ?? "create",
      step,
      attempt: 1,
      createdAt: extra.createdAt ?? new Date(NOW),
      payload: extra.payload ?? { orderId: OID },
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: "database",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: {},
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret Orders DB",
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

const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");
const db = (state: string, tags: unknown[] = [{ key: "tc:resource", value: RID }]) =>
  lightsailOk({ relationalDatabase: { name: DB, state, tags } });

describe("database create", () => {
  it("creates a private database with generated names and no password (R11, U9)", async () => {
    const { aws, adapter, ctx, bodyOf } = setup();
    aws.on("lightsail", "GetRelationalDatabase", notFound());
    aws.on("lightsail", "CreateRelationalDatabase", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_available", patch: { awsName: DB } });
    const body = bodyOf("CreateRelationalDatabase");
    expect(body).toMatchObject({
      relationalDatabaseName: DB,
      publiclyAccessible: false,
      relationalDatabaseBundleId: "micro_2_0",
      relationalDatabaseBlueprintId: "postgres_16",
    });
    expect(body.masterUserPassword).toBeUndefined();
    expect(body.tags).toEqual(expect.arrayContaining([{ key: "tc:resource", value: RID }]));
    expect(aws.seen.map((r) => r.body).join("\n")).not.toContain("My Secret Orders DB");
    expect(JSON.stringify(r)).not.toMatch(/pass/i);
  });

  it("a retried create finds its database and makes none (R7); a foreign one is a conflict", async () => {
    const a = setup();
    a.aws.on("lightsail", "GetRelationalDatabase", db("creating"));
    expect(await a.adapter.aws.create(a.ctx("create_database"))).toMatchObject({
      kind: "next",
      step: "wait_available",
    });
    expect(a.calls()).toEqual(["GetRelationalDatabase"]);
    const b = setup();
    b.aws.on(
      "lightsail",
      "GetRelationalDatabase",
      db("creating", [{ key: "tc:resource", value: "x" }]),
    );
    await expect(b.adapter.aws.create(b.ctx("create_database"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("waits while creating, finishes active when available, bounds its waiting", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("creating"));
    expect(await adapter.aws.create(ctx("wait_available"))).toMatchObject({ kind: "wait" });
    await expect(
      adapter.aws.create(ctx("wait_available", { createdAt: new Date(NOW - 3_600_000) })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    expect(await adapter.aws.create(ctx("wait_available"))).toMatchObject({
      kind: "done",
      patch: { state: "active", awsName: DB },
    });
  });

  it("fails closed when the catalog row is missing", async () => {
    const aws = setup();
    aws.aws.on("lightsail", "GetRelationalDatabase", notFound());
    const adapter = createDatabaseAdapter({ loadLaunch: async () => null });
    await expect(adapter.aws.create(aws.ctx(null) as never)).rejects.toMatchObject({
      code: "validation",
    });
    expect(aws.calls()).toEqual(["GetRelationalDatabase"]);
  });
});

describe("stop, start, snapshot, destroy cycle", () => {
  it("stop waits until stopped; start waits until available", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    aws.on("lightsail", "StopRelationalDatabase", lightsailOk({}));
    expect(await adapter.aws.action("stop", ctx(null, { kind: "stop" }))).toMatchObject({
      kind: "wait",
      step: "wait_stopped",
    });
    aws.on("lightsail", "GetRelationalDatabase", db("stopping"));
    expect(await adapter.aws.action("stop", ctx("wait_stopped", { kind: "stop" }))).toMatchObject({
      kind: "wait",
    });
    aws.on("lightsail", "GetRelationalDatabase", db("stopped"));
    expect(await adapter.aws.action("stop", ctx("wait_stopped", { kind: "stop" }))).toMatchObject({
      kind: "done",
      patch: { state: "stopped" },
    });
    aws.on("lightsail", "StartRelationalDatabase", lightsailOk({}));
    expect(await adapter.aws.action("start", ctx(null, { kind: "start" }))).toMatchObject({
      kind: "wait",
      step: "wait_started",
    });
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    expect(await adapter.aws.action("start", ctx("wait_started", { kind: "start" }))).toMatchObject(
      {
        kind: "done",
        patch: { state: "active" },
      },
    );
    expect(calls().filter((c) => c === "StopRelationalDatabase")).toHaveLength(1);
  });

  it("a retried stop of a database that is already stopped sends nothing", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("stopped"));
    expect(await adapter.aws.action("stop", ctx(null, { kind: "stop" }))).toMatchObject({
      kind: "done",
    });
    expect(calls()).toEqual(["GetRelationalDatabase"]);
  });

  it("suspend stops and resume starts (lifecycle)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("stopped"));
    expect(await adapter.aws.suspend(ctx(null, { kind: "suspend" }))).toMatchObject({
      kind: "done",
      patch: { state: "suspended" },
    });
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    expect(await adapter.aws.resume(ctx(null, { kind: "resume" }))).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
  });

  it("final snapshot: one snapshot, waits until available, starts a stopped database first", async () => {
    const { aws, adapter, ctx, calls, bodyOf } = setup();
    aws.on("lightsail", "GetRelationalDatabaseSnapshot", notFound());
    aws.on("lightsail", "GetRelationalDatabase", db("stopped"));
    aws.on("lightsail", "StartRelationalDatabase", lightsailOk({}));
    expect(await adapter.aws.finalSnapshot(ctx(null, { kind: "final_snapshot" }))).toMatchObject({
      kind: "wait",
    });
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    aws.on("lightsail", "CreateRelationalDatabaseSnapshot", lightsailOk({}));
    expect(
      await adapter.aws.finalSnapshot(ctx("snapshot", { kind: "final_snapshot" })),
    ).toMatchObject({ kind: "wait", step: "wait_snapshot" });
    expect(bodyOf("CreateRelationalDatabaseSnapshot")).toEqual({
      relationalDatabaseName: DB,
      relationalDatabaseSnapshotName: SNAP,
    });
    aws.on(
      "lightsail",
      "GetRelationalDatabaseSnapshot",
      lightsailOk({ relationalDatabaseSnapshot: { state: "creating" } }),
    );
    expect(
      await adapter.aws.finalSnapshot(ctx("wait_snapshot", { kind: "final_snapshot" })),
    ).toMatchObject({ kind: "wait" });
    aws.on(
      "lightsail",
      "GetRelationalDatabaseSnapshot",
      lightsailOk({ relationalDatabaseSnapshot: { state: "available" } }),
    );
    expect(
      await adapter.aws.finalSnapshot(ctx("wait_snapshot", { kind: "final_snapshot" })),
    ).toMatchObject({ kind: "done" });
    expect(calls().filter((c) => c === "CreateRelationalDatabaseSnapshot")).toHaveLength(1);
  });

  it("destroy deletes without a second snapshot, treats not found as done, and purge deletes the snapshot", async () => {
    const { aws, adapter, ctx, bodyOf } = setup();
    aws.on("lightsail", "DeleteRelationalDatabase", notFound());
    expect(await adapter.aws.destroy(ctx(null, { kind: "destroy" }))).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
    expect(bodyOf("DeleteRelationalDatabase")).toEqual({
      relationalDatabaseName: DB,
      skipFinalSnapshot: true,
    });
    aws.on("lightsail", "DeleteRelationalDatabaseSnapshot", notFound());
    expect(await adapter.aws.purgeSnapshots(ctx(null, { kind: "purge_snapshots" }))).toMatchObject({
      kind: "done",
    });
    expect(bodyOf("DeleteRelationalDatabaseSnapshot")).toEqual({
      relationalDatabaseSnapshotName: SNAP,
    });
  });
});

describe("manual snapshots and refusals", () => {
  it("create_backup uses only a backup row that is a child of this database (R8)", async () => {
    const good = setup(async () => backupRow());
    good.aws.on("lightsail", "GetRelationalDatabaseSnapshot", notFound());
    good.aws.on("lightsail", "CreateRelationalDatabaseSnapshot", lightsailOk({}));
    const r = await good.adapter.aws.action(
      "create_backup",
      good.ctx(null, { kind: "create_backup", payload: { backupResourceId: BID } }),
    );
    expect(r).toMatchObject({ kind: "wait", step: "wait_backup" });
    expect(good.bodyOf("CreateRelationalDatabaseSnapshot").relationalDatabaseSnapshotName).toBe(
      awsResourceName("snapshot", BID),
    );
    for (const owned of [
      async () => null,
      async () => backupRow({ parentResourceId: "other" }),
      async () => backupRow({ family: "disk" }),
    ]) {
      const bad = setup(owned);
      await expect(
        bad.adapter.aws.action(
          "create_backup",
          bad.ctx(null, { kind: "create_backup", payload: { backupResourceId: BID } }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
      expect(bad.calls()).toEqual([]);
    }
  });

  it("delete_backup deletes that snapshot; an unsupported action is refused (R16)", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(async () => backupRow());
    aws.on("lightsail", "DeleteRelationalDatabaseSnapshot", lightsailOk({}));
    expect(
      await adapter.aws.action(
        "delete_backup",
        ctx(null, { kind: "delete_backup", payload: { backupResourceId: BID } }),
      ),
    ).toMatchObject({ kind: "done" });
    expect(bodyOf("DeleteRelationalDatabaseSnapshot").relationalDatabaseSnapshotName).toBe(
      awsResourceName("snapshot", BID),
    );
    // reboot is supported since WPU-G11; a kind of another family still is not.
    await expect(
      adapter.aws.action("set_ports", ctx(null, { kind: "set_ports" })),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("the password endpoint is never called by the adapter (U9, R14)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    await adapter.aws.create(ctx("wait_available"));
    await adapter.aws.describe(ctx(null));
    expect(calls().join(",")).not.toMatch(/MasterUserPassword/);
  });

  it("describe reports the live state, or missing", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetRelationalDatabase", db("available"));
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "available" });
    aws.on("lightsail", "GetRelationalDatabase", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });
});
describe("set_db_options (WPU-G7)", () => {
  const act = (h: ReturnType<typeof setup>, payload: unknown, state = "active") => {
    const c = h.ctx(null, { kind: "set_db_options", payload });
    return h.adapter.aws.action("set_db_options", {
      ...c,
      resource: { ...c.resource, state },
    });
  };

  it("sets the backup window and the public mode with the generated name (R11)", async () => {
    const h = setup();
    h.aws.on("lightsail", "UpdateRelationalDatabase", lightsailOk({ operations: [] }));
    const r = await act(h, {
      backupWindow: "16:00-16:30",
      publiclyAccessible: true,
    });
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: { backupWindow: "16:00-16:30", publiclyAccessible: true },
      },
    });
    expect(h.bodyOf("UpdateRelationalDatabase")).toEqual({
      relationalDatabaseName: awsResourceName("database", RID),
      preferredBackupWindow: "16:00-16:30",
      publiclyAccessible: true,
      applyImmediately: true,
    });
    expect(h.aws.seen.map((x) => x.body).join("\n")).not.toContain("My Secret Orders DB");
  });

  it("accepts one option alone and refuses an empty, malformed or not-active request", async () => {
    const one = setup();
    one.aws.on("lightsail", "UpdateRelationalDatabase", lightsailOk({ operations: [] }));
    await act(one, { publiclyAccessible: false });
    expect(one.bodyOf("UpdateRelationalDatabase")).not.toHaveProperty("preferredBackupWindow");
    for (const payload of [
      null,
      {},
      { backupWindow: "16:00-16:10" },
      { backupWindow: 5 },
      { publiclyAccessible: "yes" },
    ]) {
      await expect(act(setup(), payload)).rejects.toMatchObject({
        code: "validation",
      });
    }
    await expect(act(setup(), { publiclyAccessible: true }, "stopped")).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
