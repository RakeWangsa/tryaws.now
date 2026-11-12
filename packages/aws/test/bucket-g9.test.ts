import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBucketAdapter } from "../adapters/bucket";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailOk } from "./fake-aws";

// WPU-G9: the access mode is read back (B2 of WP6-T4) and a bucket can be opened to one instance of
// the customer (SetResourceAccessForBucket). Names are generated; the instance row is the customer's own.
const RID = "11111111-2222-4333-8444-555555555555";
const INSTANCE = "77777777-6666-4555-8444-333333333333";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const BUCKET = awsResourceName("bucket", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

const instanceRow = (over: Partial<ResourceView> = {}): ResourceView => ({
  id: INSTANCE,
  customerId: CID,
  family: "linux_instance",
  productId: null,
  parentResourceId: null,
  awsName: null,
  state: "active",
  config: {},
  ...over,
});

function setup(owned: (id: string) => Promise<ResourceView | null> = async () => instanceRow()) {
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
  const adapter = createBucketAdapter({ loadBundle: async () => "small_1_0" });
  const ctx = (
    payload: unknown,
    extra: { state?: string; config?: unknown } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: "set_bucket_access",
      step: null,
      attempt: 1,
      createdAt: new Date(NOW),
      payload,
    },
    stepKey: "op-1:start",
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
      displayName: "Photos",
    }),
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  const body = (action: string) => JSON.parse(aws.seen.find((r) => r.action === action)!.body);
  return { aws, adapter, ctx, calls, body };
}

describe("access mode read-back", () => {
  it("stores the mode that was set, private or public", async () => {
    for (const mode of ["private", "public"] as const) {
      const { aws, adapter, ctx } = setup();
      aws.on("lightsail", "UpdateBucket", lightsailOk({}));
      const r = await adapter.aws.action(
        "set_bucket_access",
        ctx({ mode }),
      );
      expect(r).toMatchObject({ kind: "done", patch: { configMerge: { accessMode: mode } } });
    }
  });
});

describe("set_bucket_resource_access", () => {
  it("allows one instance of the customer and remembers it", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    const r = await adapter.aws.action(
      "set_bucket_resource_access",
      ctx({ instanceId: INSTANCE, access: "allow" }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { accessInstances: [INSTANCE] } },
    });
    expect(body("SetResourceAccessForBucket")).toEqual({
      resourceName: awsResourceName("instance", INSTANCE),
      bucketName: BUCKET,
      access: "allow",
    });
  });

  it("deny removes it from the remembered list; allow twice does not repeat it", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    const twice = await adapter.aws.action(
      "set_bucket_resource_access",
      ctx({ instanceId: INSTANCE, access: "allow" }, { config: { accessInstances: [INSTANCE] } }),
    );
    expect(twice).toMatchObject({ patch: { configMerge: { accessInstances: [INSTANCE] } } });
    const gone = await adapter.aws.action(
      "set_bucket_resource_access",
      ctx({ instanceId: INSTANCE, access: "deny" }, { config: { accessInstances: [INSTANCE] } }),
    );
    expect(gone).toMatchObject({ patch: { configMerge: { accessInstances: [] } } });
  });

  it("refuses another customer's instance, a missing one, a database, a bad payload, a suspended bucket (R8, R16)", async () => {
    const cases: [unknown, (id: string) => Promise<ResourceView | null>, string?][] = [
      [{ instanceId: INSTANCE, access: "allow" }, async () => null],
      [{ instanceId: INSTANCE, access: "allow" }, async () => instanceRow({ customerId: "other" })],
      [{ instanceId: INSTANCE, access: "allow" }, async () => instanceRow({ family: "database" })],
      [{ instanceId: INSTANCE, access: "allow" }, async () => instanceRow({ state: "destroyed" })],
      [{ instanceId: INSTANCE, access: "maybe" }, async () => instanceRow()],
      [{ instanceId: "../x", access: "allow" }, async () => instanceRow()],
      [null, async () => instanceRow()],
    ];
    for (const [payload, owned] of cases) {
      const s = setup(owned);
      await expect(
        s.adapter.aws.action("set_bucket_resource_access", s.ctx(payload)),
      ).rejects.toMatchObject({ code: "validation" });
      expect(s.calls()).toEqual([]);
    }
    const s = setup();
    await expect(
      s.adapter.aws.action(
        "set_bucket_resource_access",
        s.ctx({ instanceId: INSTANCE, access: "allow" }, { state: "suspended" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
