import { awsResourceName, checkStepResult } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBucketAdapter, type BucketDeps } from "../adapters/bucket";
import type { OpCtx } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const BUCKET = awsResourceName("bucket", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");
const PRIVATE = { getObject: "private", allowPublicOverrides: false };

function setup(over: Partial<BucketDeps> = {}) {
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
  const bundleCalls: unknown[] = [];
  const deps: BucketDeps = {
    loadBundle: async (input) => {
      bundleCalls.push(input);
      return "small_1_0";
    },
    ...over,
  };
  const adapter = createBucketAdapter(deps);
  const ctx = (
    step: string | null,
    extra: { payload?: unknown; config?: unknown; state?: string } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: "create",
      step,
      attempt: 1,
      createdAt: new Date(NOW),
      payload: extra.payload ?? { orderId: OID },
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: "bucket",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: extra.state ?? "active",
      config: extra.config ?? {},
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret Photos",
    }),
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: async () => null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  const body = (action: string, nth = 0) =>
    JSON.parse(aws.seen.filter((r) => r.action === action)[nth]!.body);
  return { aws, adapter, ctx, calls, body, bundleCalls };
}

describe("create", () => {
  it("creates the bucket under a generated name, tagged, then makes it private (R11)", async () => {
    const { aws, adapter, ctx, body, bundleCalls } = setup();
    aws.on("lightsail", "GetBuckets", notFound());
    aws.on("lightsail", "CreateBucket", lightsailOk({ bucket: { name: BUCKET } }));
    const r1 = await adapter.aws.create(ctx(null));
    expect(r1).toMatchObject({ kind: "next", step: "set_private", patch: { awsName: BUCKET } });
    expect(checkStepResult(r1, new Date(NOW))).not.toBeNull();
    const create = body("CreateBucket");
    expect(create).toMatchObject({ bucketName: BUCKET, bundleId: "small_1_0" });
    expect(create.enableObjectVersioning).toBe(false);
    expect(create.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: RID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: OID },
      ]),
    );
    expect(bundleCalls).toEqual([
      { customerId: CID, productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]);
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    const r2 = await adapter.aws.create(ctx("set_private"));
    expect(r2).toMatchObject({ kind: "done", patch: { state: "active", awsName: BUCKET } });
    expect(body("UpdateBucket")).toEqual({
      bucketName: BUCKET,
      accessRules: PRIVATE,
      readonlyAccessAccounts: [],
    });
    expect(aws.seen.map((r) => r.body).join("\n")).not.toContain("My Secret Photos");
  });

  it("a retried create finds the bucket and makes none (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetBuckets",
      lightsailOk({ buckets: [{ name: BUCKET, tags: [{ key: "tc:resource", value: RID }] }] }),
    );
    expect(await adapter.aws.create(ctx(null))).toMatchObject({
      kind: "next",
      step: "set_private",
    });
    expect(calls()).toEqual(["GetBuckets"]);
  });

  it("a bucket of that name that is not ours is a conflict", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetBuckets",
      lightsailOk({ buckets: [{ name: BUCKET, tags: [{ key: "tc:resource", value: "x" }] }] }),
    );
    await expect(adapter.aws.create(ctx(null))).rejects.toMatchObject({ code: "conflict" });
    expect(calls()).toEqual(["GetBuckets"]);
  });

  it("fails closed when the product is not the customer's bundle, and on an unknown step", async () => {
    const none = setup({ loadBundle: async () => null });
    await expect(none.adapter.aws.create(none.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(none.calls()).toEqual([]);
    const { adapter, ctx } = setup();
    await expect(adapter.aws.create(ctx("nope"))).rejects.toMatchObject({ code: "internal" });
  });

  it("parseConfig refuses a bad config", () => {
    const { adapter } = setup();
    expect(() => adapter.parseConfig({})).toThrow();
  });
});

describe("suspend and resume: access is removed and restored", () => {
  const saved = { getObject: "public", allowPublicOverrides: false, readonlyAccessAccounts: [] };

  it("saves the access rules, makes the bucket private and deletes every key", async () => {
    const { aws, adapter, ctx, body, calls } = setup();
    aws.on(
      "lightsail",
      "GetBuckets",
      lightsailOk({
        buckets: [
          {
            name: BUCKET,
            accessRules: { getObject: "public", allowPublicOverrides: false },
            readonlyAccessAccounts: ["111111111111"],
          },
        ],
      }),
    );
    const r1 = await adapter.aws.suspend(ctx(null));
    expect(r1).toMatchObject({
      kind: "next",
      step: "block",
      patch: {
        configMerge: {
          savedAccess: {
            getObject: "public",
            allowPublicOverrides: false,
            readonlyAccessAccounts: ["111111111111"],
          },
        },
      },
    });
    expect(checkStepResult(r1, new Date(NOW))).not.toBeNull();
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    expect(await adapter.aws.suspend(ctx("block"))).toMatchObject({
      kind: "next",
      step: "delete_keys",
    });
    expect(body("UpdateBucket")).toEqual({
      bucketName: BUCKET,
      accessRules: PRIVATE,
      readonlyAccessAccounts: [],
    });
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({ accessKeys: [{ accessKeyId: "AKIAFAKEKEYONE0001" }, { accessKeyId: "AKIAFAKEKEYTWO0002" }] }),
    );
    aws.on("lightsail", "DeleteBucketAccessKey", lightsailOk({}));
    const done = await adapter.aws.suspend(ctx("delete_keys"));
    expect(done).toMatchObject({ kind: "done", patch: { state: "suspended" } });
    const deleted = aws.seen
      .filter((r) => r.action === "DeleteBucketAccessKey")
      .map((r) => JSON.parse(r.body));
    expect(deleted).toEqual([
      { bucketName: BUCKET, accessKeyId: "AKIAFAKEKEYONE0001" },
      { bucketName: BUCKET, accessKeyId: "AKIAFAKEKEYTWO0002" },
    ]);
    expect(calls()).not.toContain("CreateBucketAccessKey");
  });

  it("a retry after the block must not save the private rules over the real ones", async () => {
    const { aws, adapter, ctx, calls } = setup();
    expect(await adapter.aws.suspend(ctx(null, { config: { savedAccess: saved } }))).toMatchObject({
      kind: "next",
      step: "block",
    });
    expect(calls()).toEqual([]);
    expect(aws.seen.filter((r) => r.service === "lightsail")).toEqual([]);
  });

  it("a key that is already gone counts as deleted", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({ accessKeys: [{ accessKeyId: "AKIAFAKEKEYONE0001" }] }),
    );
    aws.on("lightsail", "DeleteBucketAccessKey", notFound());
    expect(await adapter.aws.suspend(ctx("delete_keys"))).toMatchObject({ kind: "done" });
  });

  it("resume restores the saved access and clears it; keys are not restored", async () => {
    const { aws, adapter, ctx, body, calls } = setup();
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    const r = await adapter.aws.resume(
      ctx(null, { config: { savedAccess: saved }, state: "suspended" }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { state: "active", configMerge: { savedAccess: null } },
    });
    expect(checkStepResult(r, new Date(NOW))).not.toBeNull();
    expect(body("UpdateBucket")).toEqual({
      bucketName: BUCKET,
      accessRules: { getObject: "public", allowPublicOverrides: false },
      readonlyAccessAccounts: [],
    });
    expect(calls()).toEqual(["UpdateBucket"]);
  });

  it("resume without saved access, or with a surprising one, fails closed", async () => {
    const { adapter, ctx, calls } = setup();
    await expect(adapter.aws.resume(ctx(null))).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.aws.resume(ctx(null, { config: { savedAccess: { getObject: "owner" } } })),
    ).rejects.toMatchObject({ code: "validation" });
    expect(calls()).toEqual([]);
  });
});

describe("destroy, snapshots, describe", () => {
  it("force-deletes the bucket only from suspended, and not found is done", async () => {
    const { aws, adapter, ctx, body, calls } = setup();
    await expect(adapter.aws.destroy(ctx(null, { state: "active" }))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(calls()).toEqual([]);
    aws.on("lightsail", "DeleteBucket", notFound());
    const r = await adapter.aws.destroy(ctx(null, { state: "suspended" }));
    expect(r).toMatchObject({ kind: "done", patch: { state: "destroyed" } });
    expect(body("DeleteBucket")).toEqual({ bucketName: BUCKET, forceDelete: true });
  });

  it("a bucket has no snapshot: both snapshot methods are done without AWS", async () => {
    const { adapter, ctx, calls } = setup();
    expect(await adapter.aws.finalSnapshot(ctx(null))).toMatchObject({ kind: "done" });
    expect(await adapter.aws.purgeSnapshots(ctx(null))).toMatchObject({ kind: "done" });
    expect(calls()).toEqual([]);
  });

  it("describe reports the live state or missing", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetBuckets",
      lightsailOk({ buckets: [{ name: BUCKET, state: { code: "OK" } }] }),
    );
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "ok" });
    aws.on("lightsail", "GetBuckets", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });
});

describe("actions", () => {
  it("set_bucket_access validates the payload and works on an active bucket only", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    await adapter.aws.action("set_bucket_access", ctx(null, { payload: { mode: "public" } }));
    expect(body("UpdateBucket")).toEqual({
      bucketName: BUCKET,
      accessRules: { getObject: "public", allowPublicOverrides: false },
    });
    await expect(
      adapter.aws.action("set_bucket_access", ctx(null, { payload: { mode: "everyone" } })),
    ).rejects.toMatchObject({ code: "validation" });
    // a suspended bucket stays closed
    await expect(
      adapter.aws.action(
        "set_bucket_access",
        ctx(null, { payload: { mode: "public" }, state: "suspended" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("delete_access_key deletes a key of this bucket only", async () => {
    const { aws, adapter, ctx, calls, body } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({ accessKeys: [{ accessKeyId: "AKIAFAKEKEYONE0001" }] }),
    );
    aws.on("lightsail", "DeleteBucketAccessKey", lightsailOk({}));
    await adapter.aws.action(
      "delete_access_key",
      ctx(null, { payload: { accessKeyId: "AKIAFAKEKEYONE0001" } }),
    );
    expect(body("DeleteBucketAccessKey")).toEqual({ bucketName: BUCKET, accessKeyId: "AKIAFAKEKEYONE0001" });
    await expect(
      adapter.aws.action(
        "delete_access_key",
        ctx(null, { payload: { accessKeyId: "AKIAOTHERCUSTOMER" } }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      adapter.aws.action("delete_access_key", ctx(null, { payload: { accessKeyId: "bad key!" } })),
    ).rejects.toMatchObject({ code: "validation" });
    expect(calls().filter((c) => c === "DeleteBucketAccessKey")).toHaveLength(1);
  });

  it("any other kind is refused", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.action("reboot", ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
  });
});
