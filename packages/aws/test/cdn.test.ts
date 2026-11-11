import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createCdnAdapter, type CdnDeps } from "../adapters/cdn";
import type { OpCtx, ResourceView } from "../adapters/types";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const ORIGIN = "99999999-8888-4777-8666-555555555555";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DIST = awsResourceName("cdn", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

const origin = (over: Partial<ResourceView> = {}): ResourceView => ({
  id: ORIGIN,
  customerId: CID,
  family: "linux_instance",
  productId: null,
  parentResourceId: null,
  awsName: null,
  state: "active",
  config: { region: "ap-southeast-1" },
  ...over,
});

function setup(
  over: { rows?: Record<string, ResourceView>; deps?: Partial<CdnDeps>; resource?: unknown } = {},
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
  const bundleCalls: unknown[] = [];
  const deps: CdnDeps = {
    loadBundle: async (input) => {
      bundleCalls.push(input);
      return "small_1_0";
    },
    ...over.deps,
  };
  const adapter = createCdnAdapter(deps);
  const rows = over.rows ?? { [ORIGIN]: origin() };
  const ctx = (
    step: string | null,
    extra: {
      kind?: OperationKind;
      state?: string;
      createdAt?: Date;
      config?: Record<string, unknown>;
    } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: extra.kind ?? "create",
      step,
      attempt: 1,
      createdAt: extra.createdAt ?? new Date(NOW),
      payload: { orderId: OID },
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: "cdn",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: extra.state ?? "creating",
      config: over.resource ?? {},
    },
    config: adapter.parseConfig({
      productId: PRODUCT,
      region: "us-east-1",
      displayName: "My Secret CDN shop.example.com",
      originId: ORIGIN,
      cacheBehavior: "cache",
      ...extra.config,
    }),
    account: POOL,
    region: "us-east-1",
    access,
    env: "staging",
    clock,
    owned: async (id) => rows[id] ?? null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  const seen = (action: string, nth = 0) => aws.seen.filter((r) => r.action === action)[nth]!;
  const body = (action: string, nth = 0) => JSON.parse(seen(action, nth).body);
  const distribution = (status: string, extra: Record<string, unknown> = {}) =>
    lightsailOk({
      distributions: [
        {
          name: DIST,
          status,
          isEnabled: true,
          tags: [{ key: "tc:resource", value: RID }],
          ...extra,
        },
      ],
    });
  return { aws, adapter, ctx, calls, seen, body, bundleCalls, distribution };
}

describe("create", () => {
  it("creates one distribution in us-east-1 from the catalog bundle, under a generated name (R11, R7)", async () => {
    const { aws, adapter, ctx, body, seen, bundleCalls } = setup();
    aws.on("lightsail", "GetDistributions", notFound());
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { name: "x", isStaticIp: true } }));
    aws.on("lightsail", "CreateDistribution", lightsailOk({ operation: {} }));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_ready", patch: { awsName: DIST } });
    const create = body("CreateDistribution");
    expect(create).toMatchObject({
      distributionName: DIST,
      bundleId: "small_1_0",
      defaultCacheBehavior: { behavior: "cache" },
      origin: {
        name: awsResourceName("instance", ORIGIN),
        regionName: "ap-southeast-1",
        protocolPolicy: "http-only",
      },
    });
    expect(create.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: RID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: OID },
      ]),
    );
    expect(seen("CreateDistribution").host).toContain("us-east-1");
    expect(seen("GetInstance").host).toContain("ap-southeast-1");
    expect(bundleCalls).toEqual([{ customerId: CID, productId: PRODUCT }]);
    // Customer text (the display name, a domain) is in no request (R11).
    const sent = aws.seen.map((s) => s.body).join("\n");
    expect(sent).not.toContain("My Secret CDN");
    expect(sent).not.toContain("example.com");
    expect(create.certificateName).toBeUndefined();
    expect(create.alternativeDomainNames).toBeUndefined();
  });

  it("passes the cache behavior of the config", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "GetDistributions", notFound());
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { isStaticIp: true } }));
    aws.on("lightsail", "CreateDistribution", lightsailOk({}));
    await adapter.aws.create(ctx(null, { config: { cacheBehavior: "dont-cache" } }));
    expect(body("CreateDistribution").defaultCacheBehavior).toEqual({ behavior: "dont-cache" });
  });

  it("looks the origin up by family: a load balancer by http, a bucket without a protocol policy", async () => {
    const lb = setup({ rows: { [ORIGIN]: origin({ family: "load_balancer" }) } });
    lb.aws.on("lightsail", "GetDistributions", notFound());
    lb.aws.on("lightsail", "GetLoadBalancer", lightsailOk({ loadBalancer: { name: "x" } }));
    lb.aws.on("lightsail", "CreateDistribution", lightsailOk({}));
    await lb.adapter.aws.create(lb.ctx(null));
    expect(lb.body("CreateDistribution").origin).toEqual({
      name: awsResourceName("lb", ORIGIN),
      regionName: "ap-southeast-1",
      protocolPolicy: "http-only",
    });

    const bucket = setup({ rows: { [ORIGIN]: origin({ family: "bucket" }) } });
    bucket.aws.on("lightsail", "GetDistributions", notFound());
    bucket.aws.on("lightsail", "GetBuckets", lightsailOk({ buckets: [{ name: "x" }] }));
    bucket.aws.on("lightsail", "CreateDistribution", lightsailOk({}));
    await bucket.adapter.aws.create(bucket.ctx(null));
    expect(bucket.body("CreateDistribution").origin).toEqual({
      name: awsResourceName("bucket", ORIGIN),
      regionName: "ap-southeast-1",
    });
  });

  it("a retried create finds the distribution and makes none (R7); a foreign one is a conflict", async () => {
    const { aws, adapter, ctx, calls, distribution } = setup();
    aws.on("lightsail", "GetDistributions", distribution("InProgress"));
    expect(await adapter.aws.create(ctx(null))).toMatchObject({ step: "wait_ready" });
    expect(calls()).toEqual(["GetDistributions"]);

    const foreign = setup();
    foreign.aws.on(
      "lightsail",
      "GetDistributions",
      lightsailOk({ distributions: [{ name: DIST, tags: [{ key: "tc:resource", value: "x" }] }] }),
    );
    await expect(foreign.adapter.aws.create(foreign.ctx(null))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("fails closed, before any create, without a bundle or without an origin of the customer (R8, R16)", async () => {
    const noBundle = setup({ deps: { loadBundle: async () => null } });
    await expect(noBundle.adapter.aws.create(noBundle.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(noBundle.calls()).toEqual([]);

    const bad: Record<string, ResourceView | undefined> = {
      missing: undefined,
      foreign: origin({ customerId: OTHER }),
      "not an origin": origin({ family: "database" }),
      "not active": origin({ state: "suspended" }),
      "no region": origin({ config: {} }),
      "odd region": origin({ config: { region: "mars-north-1" } }),
    };
    for (const [name, row] of Object.entries(bad)) {
      const s = setup({ rows: row === undefined ? {} : { [ORIGIN]: row } });
      s.aws.on("lightsail", "GetDistributions", notFound());
      await expect(s.adapter.aws.create(s.ctx(null)), name).rejects.toMatchObject({
        code: "validation",
      });
      expect(s.calls(), name).not.toContain("CreateDistribution");
    }
  });

  it("refuses an origin that the pool account of the distribution does not know, or an instance without a static IP", async () => {
    const unknown = setup();
    unknown.aws.on("lightsail", "GetDistributions", notFound());
    unknown.aws.on("lightsail", "GetInstance", notFound());
    await expect(unknown.adapter.aws.create(unknown.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(unknown.calls()).not.toContain("CreateDistribution");

    const dynamic = setup();
    dynamic.aws.on("lightsail", "GetDistributions", notFound());
    dynamic.aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: "x", isStaticIp: false } }),
    );
    await expect(dynamic.adapter.aws.create(dynamic.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(dynamic.calls()).not.toContain("CreateDistribution");
  });

  it("waits while AWS deploys, within the budget, and fails after it", async () => {
    const { aws, adapter, ctx, distribution } = setup();
    aws.on("lightsail", "GetDistributions", distribution("InProgress"));
    expect(await adapter.aws.create(ctx("wait_ready"))).toMatchObject({
      kind: "wait",
      step: "wait_ready",
    });
    await expect(
      adapter.aws.create(ctx("wait_ready", { createdAt: new Date(NOW - 3_600_000) })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    aws.on("lightsail", "GetDistributions", distribution("Failed"));
    await expect(adapter.aws.create(ctx("wait_ready"))).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("is done when deployed, and keeps the default domain, if it is a plain host name (U6)", async () => {
    const { aws, adapter, ctx, distribution } = setup();
    aws.on(
      "lightsail",
      "GetDistributions",
      distribution("Deployed", { domainName: "d1a2b3c4d5e6f7.cloudfront.net" }),
    );
    expect(await adapter.aws.create(ctx("wait_ready"))).toMatchObject({
      kind: "done",
      patch: {
        state: "active",
        awsName: DIST,
        configMerge: { defaultDomain: "d1a2b3c4d5e6f7.cloudfront.net" },
      },
    });
    aws.on(
      "lightsail",
      "GetDistributions",
      distribution("Deployed", { domainName: "<script>.example" }),
    );
    const odd = await adapter.aws.create(ctx("wait_ready"));
    expect(odd).toMatchObject({ kind: "done", patch: { state: "active" } });
    expect(JSON.stringify(odd)).not.toContain("script");
  });

  it("an unknown step is an internal error", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.create(ctx("nope"))).rejects.toMatchObject({ code: "internal" });
  });
});

describe("suspend, resume and the customer's switch", () => {
  it("suspend disables and resume enables the distribution; the settings stay in the config", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "UpdateDistribution", lightsailOk({}));
    expect(
      await adapter.aws.suspend(ctx(null, { kind: "suspend", state: "active" })),
    ).toMatchObject({
      kind: "done",
      patch: { state: "suspended" },
    });
    expect(body("UpdateDistribution", 0)).toEqual({ distributionName: DIST, isEnabled: false });
    expect(
      await adapter.aws.resume(ctx(null, { kind: "resume", state: "suspended" })),
    ).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
    expect(body("UpdateDistribution", 1)).toEqual({ distributionName: DIST, isEnabled: true });
  });

  it("stop and start are setCdnEnabled: only from active and from stopped", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "UpdateDistribution", lightsailOk({}));
    expect(
      await adapter.aws.action("stop", ctx(null, { kind: "stop", state: "active" })),
    ).toMatchObject({ kind: "done", patch: { state: "stopped" } });
    expect(body("UpdateDistribution")).toEqual({ distributionName: DIST, isEnabled: false });
    expect(
      await adapter.aws.action("start", ctx(null, { kind: "start", state: "stopped" })),
    ).toMatchObject({ kind: "done", patch: { state: "active" } });
    await expect(
      adapter.aws.action("stop", ctx(null, { kind: "stop", state: "stopped" })),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      adapter.aws.action("start", ctx(null, { kind: "start", state: "active" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("every other action is refused (R16)", async () => {
    const { adapter, ctx, calls } = setup();
    for (const kind of ["reboot", "rename", "set_ports", "deploy_containers"] as const) {
      await expect(adapter.aws.action(kind, ctx(null, { kind }))).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(calls()).toEqual([]);
  });
});

describe("destroy, snapshots, describe and config", () => {
  it("destroy deletes the distribution; a missing one is done; no snapshot exists for a CDN", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "DeleteDistribution", lightsailOk({}));
    expect(
      await adapter.aws.destroy(ctx(null, { kind: "destroy", state: "suspended" })),
    ).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
    expect(body("DeleteDistribution")).toEqual({ distributionName: DIST });
    aws.on("lightsail", "DeleteDistribution", notFound());
    expect(await adapter.aws.destroy(ctx(null, { kind: "destroy" }))).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
    expect(await adapter.aws.finalSnapshot(ctx(null))).toMatchObject({ kind: "done" });
    expect(await adapter.aws.purgeSnapshots(ctx(null))).toMatchObject({ kind: "done" });
    expect(aws.seen.map((s) => s.action)).not.toContain("CreateDistributionSnapshot");
  });

  it("describe reports the AWS status, or missing", async () => {
    const { aws, adapter, ctx, distribution } = setup();
    aws.on("lightsail", "GetDistributions", distribution("Deployed"));
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "deployed" });
    aws.on("lightsail", "GetDistributions", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });

  it("parseConfig keeps five fields, drops a domain and refuses a bad config", () => {
    const { adapter } = setup();
    expect(
      adapter.parseConfig({
        productId: PRODUCT,
        region: "us-east-1",
        displayName: "x",
        originId: ORIGIN,
        domain: "shop.example.com",
        awsName: "tc-cdn-1",
      }),
    ).toEqual({
      productId: PRODUCT,
      region: "us-east-1",
      displayName: "x",
      originId: ORIGIN,
      cacheBehavior: "cache",
    });
    expect(() => adapter.parseConfig({ productId: "x" })).toThrow();
    expect(adapter.family).toBe("cdn");
  });

  it("an AWS error is mapped and shows no raw text (U6)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "UpdateDistribution", notFound());
    const error = await adapter.aws
      .suspend(ctx(null, { kind: "suspend", state: "active" }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "not_found" });
    expectNoLeak(error);
  });
});
