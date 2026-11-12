import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBucketAdapter } from "../adapters/bucket";
import type { OpCtx } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-G9 (security review): suspending a bucket closes it for the instances it was opened to, both the
// ones the platform granted (config.accessInstances) and any grant made outside it (GetBuckets
// resourcesReceivingAccess). A list that cannot be read fails the step; a repeat sends the same denies.
const RID = "11111111-2222-4333-8444-555555555555";
const A = "77777777-6666-4555-8444-333333333333";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const BUCKET = awsResourceName("bucket", RID);
const OUTSIDE = "i-made-outside-the-platform";
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

function setup(config: unknown = {}) {
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
  const ctx = (step: string | null): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: "suspend",
      step,
      attempt: 1,
      createdAt: new Date(NOW),
      payload: {},
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: "bucket",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "active",
      config,
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
    owned: async () => null,
  });
  const denies = () =>
    aws.seen
      .filter((r) => r.action === "SetResourceAccessForBucket")
      .map(
        (r) => JSON.parse(r.body) as { resourceName: string; bucketName: string; access: string },
      );
  return { aws, adapter, ctx, denies };
}

const bucketWith = (names: string[]) =>
  lightsailOk({
    buckets: [
      {
        name: BUCKET,
        resourcesReceivingAccess: names.map((name) => ({ name, resourceType: "Instance" })),
      },
    ],
  });

describe("suspend closes the access of instances", () => {
  it("block leads to a revoke step, and the revoke denies the saved list", async () => {
    const { aws, adapter, ctx, denies } = setup({ accessInstances: [A] });
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    expect(await adapter.aws.suspend(ctx("block"))).toMatchObject({
      kind: "next",
      step: "revoke_access",
    });
    aws.on("lightsail", "GetBuckets", bucketWith([awsResourceName("instance", A)]));
    aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    expect(await adapter.aws.suspend(ctx("revoke_access"))).toMatchObject({
      kind: "next",
      step: "delete_keys",
    });
    expect(denies()).toEqual([
      { resourceName: awsResourceName("instance", A), bucketName: BUCKET, access: "deny" },
    ]);
  });

  it("also denies a grant made outside the platform, once per name", async () => {
    const { aws, adapter, ctx, denies } = setup({ accessInstances: [A] });
    aws.on("lightsail", "GetBuckets", bucketWith([awsResourceName("instance", A), OUTSIDE]));
    aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    await adapter.aws.suspend(ctx("revoke_access"));
    expect(
      denies()
        .map((d) => d.resourceName)
        .sort(),
    ).toEqual([awsResourceName("instance", A), OUTSIDE].sort());
    expect(denies().every((d) => d.access === "deny")).toBe(true);
  });

  it("a saved id that AWS no longer lists is still denied; an empty list sends nothing; a repeat repeats the same denies (R7)", async () => {
    const none = setup({});
    none.aws.on("lightsail", "GetBuckets", bucketWith([]));
    expect(await none.adapter.aws.suspend(none.ctx("revoke_access"))).toMatchObject({
      kind: "next",
    });
    expect(none.denies()).toEqual([]);

    const twice = setup({ accessInstances: [A] });
    twice.aws.on("lightsail", "GetBuckets", bucketWith([]));
    twice.aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    await twice.adapter.aws.suspend(twice.ctx("revoke_access"));
    await twice.adapter.aws.suspend(twice.ctx("revoke_access"));
    expect(twice.denies().map((d) => d.resourceName)).toEqual([
      awsResourceName("instance", A),
      awsResourceName("instance", A),
    ]);
  });

  it("fails the step, and does not skip it, when the list cannot be read or a deny fails (R16)", async () => {
    const unreadable = setup({ accessInstances: [A] });
    unreadable.aws.on("lightsail", "GetBuckets", lightsailError(500, "ServiceException", "boom"));
    await expect(
      unreadable.adapter.aws.suspend(unreadable.ctx("revoke_access")),
    ).rejects.toBeDefined();
    expect(unreadable.denies()).toEqual([]);

    const missing = setup({});
    missing.aws.on("lightsail", "GetBuckets", lightsailError(400, "NotFoundException", "x"));
    await expect(missing.adapter.aws.suspend(missing.ctx("revoke_access"))).rejects.toBeDefined();

    const denyFails = setup({ accessInstances: [A] });
    denyFails.aws.on("lightsail", "GetBuckets", bucketWith([]));
    denyFails.aws.on(
      "lightsail",
      "SetResourceAccessForBucket",
      lightsailError(500, "ServiceException", "x"),
    );
    await expect(
      denyFails.adapter.aws.suspend(denyFails.ctx("revoke_access")),
    ).rejects.toBeDefined();
  });

  it("resume leaves the instances closed on purpose and forgets the saved list", async () => {
    const { aws, adapter, ctx, denies } = setup({
      accessInstances: [A],
      savedAccess: {
        getObject: "private",
        allowPublicOverrides: false,
        readonlyAccessAccounts: [],
      },
    });
    aws.on("lightsail", "UpdateBucket", lightsailOk({}));
    const r = await adapter.aws.resume(ctx(null));
    expect(r).toMatchObject({
      kind: "done",
      patch: { state: "active", configMerge: { savedAccess: null, accessInstances: [] } },
    });
    expect(denies()).toEqual([]);
    expect(aws.seen.some((q) => q.action === "SetResourceAccessForBucket")).toBe(false);
  });
});

describe("suspend with a full list (WPU-S6)", () => {
  it("denies all 20 remembered instances", async () => {
    const list = Array.from(
      { length: 20 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    );
    const { aws, adapter, ctx, denies } = setup({ accessInstances: list });
    aws.on(
      "lightsail",
      "GetBuckets",
      bucketWith(list.map((id) => awsResourceName("instance", id))),
    );
    aws.on("lightsail", "SetResourceAccessForBucket", lightsailOk({}));
    await adapter.aws.suspend(ctx("revoke_access"));
    expect(
      denies()
        .map((d) => d.resourceName)
        .sort(),
    ).toEqual(list.map((id) => awsResourceName("instance", id)).sort());
  });
});
