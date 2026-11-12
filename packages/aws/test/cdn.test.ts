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
const PERIOD_END = new Date("2026-12-01T00:00:00.000Z");
const APPLY = { subscriptionId: OID, periodEnd: PERIOD_END.toISOString() };
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
    periodEndOf: async () => PERIOD_END,
    ...over.deps,
  };
  const adapter = createCdnAdapter(deps);
  const rows = over.rows ?? { [ORIGIN]: origin() };
  const ctx = (
    step: string | null,
    extra: {
      kind?: OperationKind;
      payload?: unknown;
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
      payload: extra.payload ?? { orderId: OID },
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
describe("reset_cache (WPU-G7)", () => {
  it("flushes the cache of this distribution only, by its generated name, on an active one", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "ResetDistributionCache", lightsailOk({ status: "Success" }));
    const r = await adapter.aws.action(
      "reset_cache",
      ctx(null, { kind: "reset_cache", state: "active" }),
    );
    expect(r).toMatchObject({ kind: "done" });
    expect(body("ResetDistributionCache")).toEqual({ distributionName: DIST });
  });

  it("refuses a distribution that is not active (R16)", async () => {
    const { aws, adapter, ctx } = setup();
    await expect(
      adapter.aws.action("reset_cache", ctx(null, { kind: "reset_cache", state: "stopped" })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(aws.seen.length).toBe(0);
  });
});

describe("plan change at the next renewal (WPU-G8)", () => {
  const NEXT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("schedule_plan_change stores the pending bundle and calls AWS not at all", async () => {
    const { adapter, ctx, calls, bundleCalls } = setup();
    const r = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { kind: "schedule_plan_change", state: "active", payload: { productId: NEXT } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { pendingPlan: { productId: NEXT } } },
    });
    expect(bundleCalls).toEqual([{ customerId: CID, productId: NEXT }]);
    expect(calls()).toEqual([]);
    const cleared = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { state: "stopped", payload: { productId: null } }),
    );
    expect(cleared).toMatchObject({ patch: { configMerge: { pendingPlan: null } } });
  });

  it("refuses the current bundle product, a bad id, an unknown bundle and a dead distribution", async () => {
    const { adapter, ctx } = setup();
    for (const productId of [PRODUCT, "nope", 7, undefined]) {
      await expect(
        adapter.aws.action(
          "schedule_plan_change",
          ctx(null, { state: "active", payload: { productId } }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
    }
    const none = setup({ deps: { loadBundle: async () => null } });
    await expect(
      none.adapter.aws.action(
        "schedule_plan_change",
        none.ctx(null, { state: "active", payload: { productId: NEXT } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.aws.action(
        "schedule_plan_change",
        ctx(null, { state: "destroyed", payload: { productId: NEXT } }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("change_cdn_bundle (the renewal's apply) sets the bundle of the catalog product and keeps it as the applied plan", async () => {
    const { aws, adapter, ctx, body } = setup({ deps: { loadBundle: async () => "large_1_0" } });
    aws.on("lightsail", "UpdateDistributionBundle", lightsailOk({}));
    const r = await adapter.aws.action(
      "change_cdn_bundle",
      ctx(null, {
        kind: "change_cdn_bundle",
        state: "active",
        payload: { productId: NEXT, ...APPLY },
      }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          productId: NEXT,
          appliedPlan: { productId: NEXT },
          pendingPlan: null,
          pendingPlanFailed: null,
        },
      },
    });
    expect(body("UpdateDistributionBundle")).toEqual({
      distributionName: DIST,
      bundleId: "large_1_0",
    });
    await expect(
      adapter.aws.action(
        "change_cdn_bundle",
        ctx(null, { state: "active", payload: { productId: "x" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  // WPU-S7: the apply is bound to the period it was queued for.
  it("change_cdn_bundle whose period has moved is skipped: no AWS call, the pending plan stays, no failure", async () => {
    const moved = new Date(PERIOD_END.getTime() + 30 * 86_400_000);
    const { aws, adapter, ctx } = setup({
      deps: { loadBundle: async () => "large_1_0", periodEndOf: async () => moved },
    });
    aws.on("lightsail", "UpdateDistributionBundle", lightsailOk({}));
    const r = await adapter.aws.action(
      "change_cdn_bundle",
      ctx(null, {
        kind: "change_cdn_bundle",
        state: "active",
        payload: { productId: NEXT, ...APPLY },
      }),
    );
    expect(r).toEqual({
      kind: "done",
      patch: {
        configMerge: { planApplySkipped: { operationId: "op-1", reason: "period_moved" } },
      },
    });
    expect(aws.seen.map((x) => x.action)).not.toContain("UpdateDistributionBundle");
  });

  it("change_cdn_bundle is skipped without a period in the payload and retried when the period cannot be read (R16)", async () => {
    const { aws, adapter, ctx } = setup({ deps: { loadBundle: async () => "large_1_0" } });
    aws.on("lightsail", "UpdateDistributionBundle", lightsailOk({}));
    const r = await adapter.aws.action(
      "change_cdn_bundle",
      ctx(null, { kind: "change_cdn_bundle", state: "active", payload: { productId: NEXT } }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { planApplySkipped: {} } } });
    const down = setup({
      deps: {
        loadBundle: async () => "large_1_0",
        periodEndOf: async () => {
          throw new Error("db down");
        },
      },
    });
    down.aws.on("lightsail", "UpdateDistributionBundle", lightsailOk({}));
    await expect(
      down.adapter.aws.action(
        "change_cdn_bundle",
        down.ctx(null, {
          kind: "change_cdn_bundle",
          state: "active",
          payload: { productId: NEXT, ...APPLY },
        }),
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(down.aws.seen.map((x) => x.action)).not.toContain("UpdateDistributionBundle");
  });

  // WPU-S2: core/lifecycle PLAN_APPLY_STATES says cdn applies in `active` only; this pins the adapter.
  it("change_cdn_bundle applies in the active state only", async () => {
    const { adapter, ctx } = setup({ deps: { loadBundle: async () => "large_1_0" } });
    for (const state of ["stopped", "suspended", "provisioning", "retained"]) {
      await expect(
        adapter.aws.action(
          "change_cdn_bundle",
          ctx(null, { kind: "change_cdn_bundle", state, payload: { productId: NEXT } }),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    }
  });

  // WPU-S3: the customer cannot clear the failure mark for free. Re-scheduling the failed product is
  // refused, another product is allowed, and neither a schedule nor a cancel writes the mark.
  it("refuses to schedule the product whose apply failed; another product is allowed; the mark is never touched", async () => {
    const failed = {
      pendingPlan: { productId: NEXT },
      pendingPlanFailed: { code: "conflict", productId: NEXT, period: "2026-11-01T00:00:00.000Z" },
    };
    const { adapter, ctx } = setup({ resource: failed });
    await expect(
      adapter.aws.action(
        "schedule_plan_change",
        ctx(null, { state: "active", payload: { productId: NEXT } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const other = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { state: "active", payload: { productId: OTHER } }),
    );
    expect(other).toMatchObject({ patch: { configMerge: { pendingPlan: { productId: OTHER } } } });
    const cancelled = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { state: "active", payload: { productId: null } }),
    );
    for (const r of [other, cancelled]) {
      expect(
        (r as unknown as { patch: { configMerge: object } }).patch.configMerge,
      ).not.toHaveProperty("pendingPlanFailed");
    }
    const clean = setup();
    await expect(
      clean.adapter.aws.action(
        "schedule_plan_change",
        clean.ctx(null, { state: "active", payload: { productId: NEXT } }),
      ),
    ).resolves.toMatchObject({ kind: "done" });
  });
});

describe("set_cache_behaviors (WPU-G8)", () => {
  const POLICY = {
    defaultBehavior: "cache",
    settings: {
      defaultTtl: 3600,
      minimumTtl: 0,
      maximumTtl: 86400,
      allowedHttpMethods: "GET,HEAD",
      cachedHttpMethods: "GET,HEAD",
      cookies: "none",
      headers: "none",
      queryStrings: false,
    },
    paths: [{ path: "images/*", behavior: "cache" }],
  };

  it("sends the whole policy of the checked payload to UpdateDistribution", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "UpdateDistribution", lightsailOk({}));
    const r = await adapter.aws.action(
      "set_cache_behaviors",
      ctx(null, { kind: "set_cache_behaviors", state: "active", payload: POLICY }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { cachePolicy: POLICY } } });
    expect(body("UpdateDistribution")).toEqual({
      distributionName: DIST,
      defaultCacheBehavior: { behavior: "cache" },
      cacheBehaviorSettings: {
        defaultTTL: 3600,
        minimumTTL: 0,
        maximumTTL: 86400,
        allowedHTTPMethods: "GET,HEAD",
        cachedHTTPMethods: "GET,HEAD",
        forwardedCookies: { option: "none" },
        forwardedHeaders: { option: "none" },
        forwardedQueryStrings: { option: false },
      },
      cacheBehaviors: [{ path: "images/*", behavior: "cache" }],
    });
  });

  it("refuses a payload the policy parser refuses and a distribution that is not active (R16)", async () => {
    const { aws, adapter, ctx } = setup();
    await expect(
      adapter.aws.action(
        "set_cache_behaviors",
        ctx(null, { state: "active", payload: { ...POLICY, defaultBehavior: "always" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.aws.action("set_cache_behaviors", ctx(null, { state: "stopped", payload: POLICY })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(aws.seen.length).toBe(0);
  });
});

// WPA-P2. The admin action that clears the failure mark: no AWS call, only the config patch.
describe("clear_plan_change_mark (admin, WPA-P2)", () => {
  it("removes the failure mark and calls AWS not at all; nothing else in the config is touched", async () => {
    const { adapter, ctx, calls } = setup();
    const r = await adapter.aws.action(
      "clear_plan_change_mark",
      ctx(null, { kind: "clear_plan_change_mark", state: "active", payload: {} }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { pendingPlanFailed: null } } });
    expect(
      Object.keys((r as unknown as { patch: { configMerge: object } }).patch.configMerge),
    ).toEqual(["pendingPlanFailed"]);
    expect(calls()).toEqual([]);
  });

  // WPU-M4: the credit of a failed apply drops the pending plan with the mark, so it is not re-applied.
  it("with clearPendingPlan it also drops the pending plan, but only the one the credited apply named", async () => {
    const named = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const one = setup({ resource: { pendingPlan: { productId: named } } });
    const r = await one.adapter.aws.action(
      "clear_plan_change_mark",
      one.ctx(null, { state: "active", payload: { clearPendingPlan: true, productId: named } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { pendingPlanFailed: null, pendingPlan: null } },
    });
    const other = setup({
      resource: { pendingPlan: { productId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
    });
    const kept = await other.adapter.aws.action(
      "clear_plan_change_mark",
      other.ctx(null, { state: "active", payload: { clearPendingPlan: true, productId: named } }),
    );
    expect(
      Object.keys((kept as unknown as { patch: { configMerge: object } }).patch.configMerge),
    ).toEqual(["pendingPlanFailed"]);
  });

  it("works in a stopped or suspended distribution, and a destroyed one is a conflict", async () => {
    const { adapter, ctx } = setup();
    for (const state of ["stopped", "suspended"]) {
      await expect(
        adapter.aws.action("clear_plan_change_mark", ctx(null, { state, payload: {} })),
      ).resolves.toMatchObject({ kind: "done" });
    }
    await expect(
      adapter.aws.action("clear_plan_change_mark", ctx(null, { state: "destroyed", payload: {} })),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("set_cdn_origin (WPU-G8)", () => {
  const OTHER_ORIGIN = "77777777-8888-4777-8666-555555555555";

  it("changes the origin to another resource of the same customer, by its generated name", async () => {
    const { aws, adapter, ctx, body } = setup({
      rows: { [OTHER_ORIGIN]: origin({ id: OTHER_ORIGIN, family: "bucket" }) },
    });
    aws.on(
      "lightsail",
      "GetBuckets",
      lightsailOk({ buckets: [{ name: awsResourceName("bucket", OTHER_ORIGIN) }] }),
    );
    aws.on("lightsail", "UpdateDistribution", lightsailOk({}));
    const r = await adapter.aws.action(
      "set_cdn_origin",
      ctx(null, { kind: "set_cdn_origin", state: "active", payload: { originId: OTHER_ORIGIN } }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { originId: OTHER_ORIGIN } } });
    expect(body("UpdateDistribution")).toEqual({
      distributionName: DIST,
      origin: { name: awsResourceName("bucket", OTHER_ORIGIN), regionName: "ap-southeast-1" },
    });
  });

  it("refuses another customer's resource, a missing one, a wrong family, a bad id and free text (R8, R11)", async () => {
    const rows = {
      [OTHER_ORIGIN]: origin({ id: OTHER_ORIGIN, customerId: OTHER }),
      "66666666-8888-4777-8666-555555555555": origin({
        id: "66666666-8888-4777-8666-555555555555",
        family: "database",
      }),
      "55555555-8888-4777-8666-555555555555": origin({
        id: "55555555-8888-4777-8666-555555555555",
        state: "suspended",
      }),
    };
    const { aws, adapter, ctx } = setup({ rows });
    for (const originId of [
      OTHER_ORIGIN,
      "66666666-8888-4777-8666-555555555555",
      "55555555-8888-4777-8666-555555555555",
      "44444444-8888-4777-8666-555555555555",
      "tc-instance-0123456789abcdef",
      "my-server",
      7,
    ]) {
      await expect(
        adapter.aws.action("set_cdn_origin", ctx(null, { state: "active", payload: { originId } })),
      ).rejects.toMatchObject({ code: "validation" });
    }
    expect(aws.seen.length).toBe(0);
  });
});

describe("custom domain and certificate (WPU-G8)", () => {
  const CERT = awsResourceName("cert", RID);
  const certs = (status: string) =>
    lightsailOk({
      certificates: [
        {
          certificateName: CERT,
          certificateDetail: {
            name: CERT,
            domainName: "cdn.example.com",
            status,
            domainValidationRecords: [
              { resourceRecord: { name: "_a.cdn.example.com.", type: "CNAME", value: "_b.acm." } },
            ],
          },
        },
      ],
    });

  it("request_certificate asks for one certificate under a generated name", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "GetCertificates", notFound());
    aws.on("lightsail", "CreateCertificate", lightsailOk({}));
    const r = await adapter.aws.action(
      "request_certificate",
      ctx(null, { state: "active", payload: { domain: "CDN.Example.com" } }),
    );
    expect(r).toMatchObject({
      patch: {
        configMerge: { certificate: { domain: "cdn.example.com", status: "PENDING_VALIDATION" } },
      },
    });
    expect(body("CreateCertificate")).toMatchObject({
      certificateName: CERT,
      domainName: "cdn.example.com",
    });
    await expect(
      adapter.aws.action(
        "request_certificate",
        ctx(null, { state: "active", payload: { domain: "*.x.com" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refresh_certificate records the validation records and attaches an issued certificate to the distribution", async () => {
    const { aws, adapter, ctx, body, distribution } = setup();
    aws.on("lightsail", "GetCertificates", certs("ISSUED"));
    aws.on("lightsail", "GetDistributions", distribution("Deployed"));
    aws.on("lightsail", "AttachCertificateToDistribution", lightsailOk({}));
    const r = await adapter.aws.action("refresh_certificate", ctx(null, { state: "active" }));
    expect(r).toMatchObject({
      patch: {
        configMerge: {
          certificate: {
            domain: "cdn.example.com",
            status: "ISSUED",
            attached: true,
            records: [{ name: "_a.cdn.example.com.", type: "CNAME", value: "_b.acm." }],
          },
        },
      },
    });
    expect(body("AttachCertificateToDistribution")).toEqual({
      distributionName: DIST,
      certificateName: CERT,
    });
  });

  it("a pending certificate is only recorded; one that is attached already is left alone", async () => {
    const pending = setup();
    pending.aws.on("lightsail", "GetCertificates", certs("PENDING_VALIDATION"));
    await pending.adapter.aws.action("refresh_certificate", pending.ctx(null, { state: "active" }));
    expect(pending.calls()).not.toContain("AttachCertificateToDistribution");

    const done = setup();
    done.aws.on("lightsail", "GetCertificates", certs("ISSUED"));
    done.aws.on(
      "lightsail",
      "GetDistributions",
      done.distribution("Deployed", { certificateName: CERT }),
    );
    await done.adapter.aws.action("refresh_certificate", done.ctx(null, { state: "active" }));
    expect(done.calls()).not.toContain("AttachCertificateToDistribution");
  });
});

describe("remove and replace the certificate (WPU-G11)", () => {
  const CERT = awsResourceName("cert", RID);
  const certs = (domain = "cdn.example.com") =>
    lightsailOk({
      certificates: [
        {
          certificateName: CERT,
          certificateDetail: { name: CERT, domainName: domain, status: "ISSUED" },
        },
      ],
    });

  it("remove_certificate detaches it from the distribution, deletes it and clears the saved certificate", async () => {
    const { aws, adapter, ctx, body, calls, distribution } = setup();
    aws.on("lightsail", "GetDistributions", distribution("Deployed", { certificateName: CERT }));
    aws.on("lightsail", "DetachCertificateFromDistribution", lightsailOk({}));
    aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    const r = await adapter.aws.action("remove_certificate", ctx(null, { state: "active" }));
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { certificate: null } } });
    expect(calls()).toEqual([
      "GetDistributions",
      "DetachCertificateFromDistribution",
      "DeleteCertificate",
    ]);
    expect(body("DetachCertificateFromDistribution")).toEqual({ distributionName: DIST });
    expect(body("DeleteCertificate")).toEqual({ certificateName: CERT });
  });

  it("a certificate that is not attached is only deleted, one that is gone is a clean result (R7)", async () => {
    const loose = setup();
    loose.aws.on("lightsail", "GetDistributions", loose.distribution("Deployed"));
    loose.aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    await loose.adapter.aws.action("remove_certificate", loose.ctx(null, { state: "active" }));
    expect(loose.calls()).not.toContain("DetachCertificateFromDistribution");

    const gone = setup();
    gone.aws.on("lightsail", "GetDistributions", gone.distribution("Deployed"));
    gone.aws.on("lightsail", "DeleteCertificate", notFound());
    const r = await gone.adapter.aws.action(
      "remove_certificate",
      gone.ctx(null, { state: "active" }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { certificate: null } } });
  });

  it("refuses a distribution that is not active, and one it cannot read (R16)", async () => {
    const busy = setup();
    await expect(
      busy.adapter.aws.action("remove_certificate", busy.ctx(null, { state: "creating" })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(busy.aws.seen.length).toBe(0);

    const unread = setup();
    unread.aws.on("lightsail", "GetDistributions", lightsailOk({ distributions: [] }));
    await expect(
      unread.adapter.aws.action("remove_certificate", unread.ctx(null, { state: "active" })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(unread.calls()).not.toContain("DeleteCertificate");
  });

  it("replace_certificate detaches and deletes the old one and requests a new one for the new domain", async () => {
    const { aws, adapter, ctx, body, calls, distribution } = setup();
    aws.on("lightsail", "GetDistributions", distribution("Deployed", { certificateName: CERT }));
    aws.on("lightsail", "DetachCertificateFromDistribution", lightsailOk({}));
    aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    // After the delete the old certificate is gone, so the new one is created.
    aws.on("lightsail", "GetCertificates", notFound());
    aws.on("lightsail", "CreateCertificate", lightsailOk({}));
    const r = await adapter.aws.action(
      "replace_certificate",
      ctx(null, { state: "active", payload: { domain: "New.Example.com" } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          certificate: {
            domain: "new.example.com",
            status: "PENDING_VALIDATION",
            attached: false,
            records: [],
          },
        },
      },
    });
    expect(calls().filter((c) => c !== "GetCertificates")).toEqual([
      "GetDistributions",
      "DetachCertificateFromDistribution",
      "DeleteCertificate",
      "CreateCertificate",
    ]);
    expect(body("CreateCertificate")).toMatchObject({
      certificateName: CERT,
      domainName: "new.example.com",
    });
  });

  it("replace_certificate checks the new domain before any call, and waits when the old one still shows (R11, R16)", async () => {
    const bad = setup();
    for (const domain of ["*.x.com", "localhost", "", 5, undefined]) {
      await expect(
        bad.adapter.aws.action(
          "replace_certificate",
          bad.ctx(null, { state: "active", payload: { domain } }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
    }
    expect(bad.aws.seen.length).toBe(0);

    const slow = setup();
    slow.aws.on("lightsail", "GetDistributions", slow.distribution("Deployed"));
    slow.aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    slow.aws.on("lightsail", "GetCertificates", certs("old.example.com"));
    await expect(
      slow.adapter.aws.action(
        "replace_certificate",
        slow.ctx(null, { state: "active", payload: { domain: "new.example.com" } }),
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(slow.calls()).not.toContain("CreateCertificate");
  });
});
