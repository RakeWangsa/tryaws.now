import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import {
  createContainerServiceAdapter,
  type ContainerServiceDeps,
} from "../adapters/container-service";
import type { OpCtx } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const SERVICE = awsResourceName("container", RID);
const NOW = Date.now();
const PERIOD_END = new Date("2026-12-01T00:00:00.000Z");
const APPLY = { subscriptionId: OID, periodEnd: PERIOD_END.toISOString() };
const clock = { now: () => new Date(NOW) };
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");
const DEPLOYMENT = {
  containers: [{ image: "nginx:1.27", ports: [{ port: 80, protocol: "HTTP" }] }],
  publicEndpoint: { container: 0, port: 80, healthCheckPath: "/" },
};
const AWS_DEPLOYMENT = {
  serviceName: SERVICE,
  containers: { c1: { image: "nginx:1.27", ports: { "80": "HTTP" } } },
  publicEndpoint: { containerName: "c1", containerPort: 80, healthCheck: { path: "/" } },
};

function setup(over: Partial<ContainerServiceDeps> = {}) {
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
  const planCalls: unknown[] = [];
  const deps: ContainerServiceDeps = {
    loadPlan: async (input) => {
      planCalls.push(input);
      return { power: "micro", scale: 2 };
    },
    periodEndOf: async () => PERIOD_END,
    ...over,
  };
  const adapter = createContainerServiceAdapter(deps);
  const ctx = (
    step: string | null,
    extra: {
      payload?: unknown;
      config?: unknown;
      state?: string;
      createdAt?: Date;
    } = {},
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind: "create",
      step,
      attempt: 1,
      createdAt: extra.createdAt ?? new Date(NOW),
      payload: extra.payload ?? { orderId: OID },
    },
    stepKey: `op-1:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: "container_service",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: extra.state ?? "active",
      config: extra.config ?? {},
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret API",
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
  const service = (state: string, extra: Record<string, unknown> = {}) =>
    lightsailOk({
      containerServices: [
        {
          containerServiceName: SERVICE,
          state,
          tags: [{ key: "tc:resource", value: RID }],
          ...extra,
        },
      ],
    });
  return { aws, adapter, ctx, calls, body, planCalls, service };
}

describe("create", () => {
  it("creates the service from the catalog plan under a generated name (R11)", async () => {
    const { aws, adapter, ctx, body, planCalls } = setup();
    aws.on("lightsail", "GetContainerServices", notFound());
    aws.on("lightsail", "CreateContainerService", lightsailOk({}));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_ready", patch: { awsName: SERVICE } });
    const create = body("CreateContainerService");
    expect(create).toMatchObject({ serviceName: SERVICE, power: "micro", scale: 2 });
    expect(create.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: RID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: OID },
      ]),
    );
    expect(planCalls).toEqual([
      { customerId: CID, productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]);
    expect(aws.seen.map((s) => s.body).join("\n")).not.toContain("My Secret API");
  });

  it("a retried create finds the service and makes none (R7); a foreign one is a conflict", async () => {
    const { aws, adapter, ctx, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("PENDING"));
    expect(await adapter.aws.create(ctx(null))).toMatchObject({ step: "wait_ready" });
    expect(calls()).toEqual(["GetContainerServices"]);
    aws.on(
      "lightsail",
      "GetContainerServices",
      lightsailOk({
        containerServices: [
          { containerServiceName: SERVICE, tags: [{ key: "tc:resource", value: "other" }] },
        ],
      }),
    );
    await expect(adapter.aws.create(ctx(null))).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed without a plan for the product", async () => {
    const none = setup({ loadPlan: async () => null });
    await expect(none.adapter.aws.create(none.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(none.calls()).toEqual([]);
  });

  it("waits for ready, then deploys the saved deployment once, then waits for running", async () => {
    const { aws, adapter, ctx, body, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("PENDING"));
    expect(await adapter.aws.create(ctx("wait_ready"))).toMatchObject({
      kind: "wait",
      step: "wait_ready",
    });
    await expect(
      adapter.aws.create(ctx("wait_ready", { createdAt: new Date(NOW - 3_600_000) })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    aws.on("lightsail", "GetContainerServices", service("READY"));
    expect(await adapter.aws.create(ctx("wait_ready"))).toMatchObject({
      kind: "next",
      step: "deploy",
    });
    aws.on("lightsail", "CreateContainerServiceDeployment", lightsailOk({}));
    expect(
      await adapter.aws.create(ctx("deploy", { config: { deployment: DEPLOYMENT } })),
    ).toMatchObject({ kind: "next", step: "wait_deploy" });
    expect(body("CreateContainerServiceDeployment")).toEqual(AWS_DEPLOYMENT);
    aws.on("lightsail", "GetContainerServices", service("DEPLOYING"));
    expect(await adapter.aws.create(ctx("wait_deploy"))).toMatchObject({ kind: "wait" });
    aws.on("lightsail", "GetContainerServices", service("RUNNING"));
    expect(await adapter.aws.create(ctx("wait_deploy"))).toMatchObject({
      kind: "done",
      patch: { state: "active", awsName: SERVICE },
    });
    expect(calls()).not.toContain("CreateContainerServiceRegistryLogin");
  });

  // WPU-D3 (audit C.36)
  it("stores the public host in the resource config when the service becomes active", async () => {
    const URL_OF = "https://my-svc.abc123.ap-southeast-1.cs.amazonlightsail.com/";
    const { aws, adapter, ctx, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("RUNNING", { url: URL_OF }));
    expect(await adapter.aws.create(ctx("wait_deploy"))).toMatchObject({
      kind: "done",
      patch: {
        state: "active",
        awsName: SERVICE,
        configMerge: { publicUrl: "my-svc.abc123.ap-southeast-1.cs.amazonlightsail.com" },
      },
    });
    // nothing to deploy: active at once, with the address too
    const bare = setup();
    bare.aws.on("lightsail", "GetContainerServices", bare.service("READY", { url: URL_OF }));
    expect(await bare.adapter.aws.create(bare.ctx("deploy"))).toMatchObject({
      kind: "done",
      patch: { state: "active", configMerge: { publicUrl: expect.stringContaining("my-svc") } },
    });
  });

  it("keeps no public address when AWS gives none or a URL that is not a plain https host", async () => {
    for (const url of [
      undefined,
      "",
      "http://svc.example.com/",
      "https://user:pw@svc.example.com/",
      "https://svc.example.com:8443/",
      "https://svc.example.com/path?x=1",
      "https://svc.example.com/#frag",
      "https://localhost/",
      "javascript:alert(1)",
      42,
    ]) {
      const t = setup();
      t.aws.on(
        "lightsail",
        "GetContainerServices",
        t.service("RUNNING", url === undefined ? {} : { url }),
      );
      const done = await t.adapter.aws.create(t.ctx("wait_deploy"));
      expect(done, String(url)).toMatchObject({ kind: "done", patch: { state: "active" } });
      expect(JSON.stringify(done), String(url)).not.toContain("publicUrl");
    }
  });

  it("a service with nothing to deploy is active at once; a deployed one is not deployed again", async () => {
    const { aws, adapter, ctx, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("READY"));
    expect(await adapter.aws.create(ctx("deploy"))).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
    aws.on(
      "lightsail",
      "GetContainerServices",
      service("DEPLOYING", { currentDeployment: { version: 1 } }),
    );
    expect(
      await adapter.aws.create(ctx("deploy", { config: { deployment: DEPLOYMENT } })),
    ).toMatchObject({ kind: "next", step: "wait_deploy" });
    expect(calls()).not.toContain("CreateContainerServiceDeployment");
  });

  it("a saved deployment that is not valid (a private image) is refused before AWS", async () => {
    const { aws, adapter, ctx, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("READY"));
    await expect(
      adapter.aws.create(
        ctx("deploy", {
          config: {
            deployment: {
              containers: [{ image: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/app:1" }],
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(calls()).not.toContain("CreateContainerServiceDeployment");
  });
});

describe("suspend, resume, destroy", () => {
  it("suspend disables the service, resume enables it", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    expect(await adapter.aws.suspend(ctx(null))).toMatchObject({
      kind: "done",
      patch: { state: "suspended" },
    });
    expect(body("UpdateContainerService", 0)).toEqual({ serviceName: SERVICE, isDisabled: true });
    expect(await adapter.aws.resume(ctx(null, { state: "suspended" }))).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
    expect(body("UpdateContainerService", 1)).toEqual({ serviceName: SERVICE, isDisabled: false });
  });

  it("destroys only a suspended service; not found is done; settings stay in the config", async () => {
    const { aws, adapter, ctx, calls } = setup();
    await expect(adapter.aws.destroy(ctx(null, { state: "active" }))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(calls()).toEqual([]);
    aws.on("lightsail", "DeleteContainerService", notFound());
    expect(await adapter.aws.destroy(ctx(null, { state: "suspended" }))).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
  });

  it("has no snapshot: both snapshot methods are done without AWS", async () => {
    const { adapter, ctx, calls } = setup();
    expect(await adapter.aws.finalSnapshot(ctx(null))).toMatchObject({ kind: "done" });
    expect(await adapter.aws.purgeSnapshots(ctx(null))).toMatchObject({ kind: "done" });
    expect(calls()).toEqual([]);
  });

  it("describe gives the live state, or missing", async () => {
    const { aws, adapter, ctx, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("RUNNING"));
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "running" });
    aws.on("lightsail", "GetContainerServices", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });
});

describe("actions", () => {
  it("deploy_containers validates the payload, deploys, and keeps the settings in the config", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "CreateContainerServiceDeployment", lightsailOk({}));
    const r = await adapter.aws.action(
      "deploy_containers",
      ctx(null, { payload: { ...DEPLOYMENT, orderId: OID } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          deployment: {
            containers: { c1: { image: "nginx:1.27" } },
            publicEndpoint: { containerName: "c1", containerPort: 80 },
          },
        },
      },
    });
    expect(body("CreateContainerServiceDeployment")).toEqual(AWS_DEPLOYMENT);
    await expect(
      adapter.aws.action(
        "deploy_containers",
        ctx(null, { payload: { containers: [{ image: "x y" }] } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.aws.action(
        "deploy_containers",
        ctx(null, { payload: DEPLOYMENT, state: "suspended" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("scale_container applies the plan of a catalog product of this customer only", async () => {
    const { aws, adapter, ctx, body, planCalls } = setup();
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    const product = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const r = await adapter.aws.action(
      "scale_container",
      ctx(null, { payload: { productId: product, ...APPLY } }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { productId: product } } });
    expect(body("UpdateContainerService")).toEqual({
      serviceName: SERVICE,
      power: "micro",
      scale: 2,
    });
    expect(planCalls).toEqual([{ customerId: CID, productId: product }]);
    await expect(
      adapter.aws.action("scale_container", ctx(null, { payload: { productId: "nope" } })),
    ).rejects.toMatchObject({ code: "validation" });
    const none = setup({ loadPlan: async () => null });
    await expect(
      none.adapter.aws.action(
        "scale_container",
        none.ctx(null, { payload: { productId: product, ...APPLY } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(none.calls()).toEqual([]);
  });

  it("any other kind is refused", async () => {
    const { adapter, ctx } = setup();
    for (const kind of ["reboot", "set_ports", "stop"] as OperationKind[]) {
      await expect(adapter.aws.action(kind, ctx(null))).rejects.toMatchObject({
        code: "validation",
      });
    }
  });
});

describe("plan change at the next renewal (WPU-G8)", () => {
  const NEXT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const CURRENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("schedule_plan_change stores the pending plan in the config and calls AWS not at all", async () => {
    const { adapter, ctx, calls, planCalls } = setup();
    const r = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { payload: { productId: NEXT } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { pendingPlan: { productId: NEXT } } },
    });
    expect(planCalls).toEqual([{ customerId: CID, productId: NEXT }]);
    expect(calls()).toEqual([]);
  });

  it("a null product cancels the pending plan; the current plan, a bad id and an unknown plan are refused", async () => {
    const { adapter, ctx, calls } = setup();
    const cleared = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { payload: { productId: null } }),
    );
    expect(cleared).toMatchObject({ kind: "done", patch: { configMerge: { pendingPlan: null } } });
    for (const productId of [CURRENT, "nope", 7, undefined]) {
      await expect(
        adapter.aws.action("schedule_plan_change", ctx(null, { payload: { productId } })),
      ).rejects.toMatchObject({ code: "validation" });
    }
    const none = setup({ loadPlan: async () => null });
    await expect(
      none.adapter.aws.action(
        "schedule_plan_change",
        none.ctx(null, { payload: { productId: NEXT } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      adapter.aws.action(
        "schedule_plan_change",
        ctx(null, { payload: { productId: NEXT }, state: "destroyed" }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(calls()).toEqual([]);
  });

  it("scale_container (the renewal's apply) moves the pending plan to the applied plan", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    const r = await adapter.aws.action(
      "scale_container",
      ctx(null, { payload: { productId: NEXT, ...APPLY } }),
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
  });

  // WPU-S7: the apply is bound to the period it was queued for.
  it("scale_container whose period has moved (the renewal already happened) is skipped: no AWS call, the pending plan stays, no failure", async () => {
    const moved = new Date(PERIOD_END.getTime() + 30 * 86_400_000);
    const { aws, adapter, ctx, calls } = setup({ periodEndOf: async () => moved });
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    const r = await adapter.aws.action(
      "scale_container",
      ctx(null, { payload: { productId: NEXT, ...APPLY } }),
    );
    expect(r).toEqual({
      kind: "done",
      patch: {
        configMerge: { planApplySkipped: { operationId: "op-1", reason: "period_moved" } },
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/pendingPlan|appliedPlan/);
    expect(calls()).toEqual([]);
  });

  it("scale_container is skipped when the payload names no period, and refused (retryable) when the period cannot be read (R16)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    for (const payload of [
      { productId: NEXT },
      { productId: NEXT, subscriptionId: OID },
      { productId: NEXT, subscriptionId: OID, periodEnd: "not a date" },
    ]) {
      const r = await adapter.aws.action("scale_container", ctx(null, { payload }));
      expect(r).toMatchObject({ kind: "done", patch: { configMerge: { planApplySkipped: {} } } });
    }
    expect(calls()).toEqual([]);
    for (const periodEndOf of [
      async () => null,
      async () => {
        throw new Error("db down");
      },
    ]) {
      const bad = setup({ periodEndOf });
      bad.aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
      const run = bad.adapter.aws.action(
        "scale_container",
        bad.ctx(null, { payload: { productId: NEXT, ...APPLY } }),
      );
      if (periodEndOf.toString().includes("null")) {
        await expect(run).resolves.toMatchObject({ kind: "done" });
      } else {
        await expect(run).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
      }
      expect(bad.calls()).toEqual([]);
    }
  });

  // WPU-S2: core/lifecycle PLAN_APPLY_STATES says container_service applies in `active` only; this
  // pins the adapter side. A schedule or a cancel clears the failed mark of an earlier apply.
  it("scale_container applies in the active state only (stopped, suspended and the rest are conflicts)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    for (const state of ["stopped", "suspended", "provisioning", "retained"]) {
      await expect(
        adapter.aws.action("scale_container", ctx(null, { state, payload: { productId: NEXT } })),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    expect(calls()).toEqual([]);
  });

  // WPU-S3: the customer cannot clear the failure mark for free. Re-scheduling the failed product is
  // refused, another product is allowed, and neither a schedule nor a cancel writes the mark.
  it("refuses to schedule the product whose apply failed; another product is allowed; the mark is never touched", async () => {
    const { adapter, ctx } = setup();
    const failed = {
      pendingPlan: { productId: NEXT },
      pendingPlanFailed: { code: "conflict", productId: NEXT, period: "2026-11-01T00:00:00.000Z" },
    };
    await expect(
      adapter.aws.action(
        "schedule_plan_change",
        ctx(null, { payload: { productId: NEXT }, config: failed }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const other = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { payload: { productId: OTHER }, config: failed }),
    );
    expect(other).toMatchObject({ patch: { configMerge: { pendingPlan: { productId: OTHER } } } });
    const cancelled = await adapter.aws.action(
      "schedule_plan_change",
      ctx(null, { payload: { productId: null }, config: failed }),
    );
    for (const r of [other, cancelled]) {
      expect(
        (r as unknown as { patch: { configMerge: object } }).patch.configMerge,
      ).not.toHaveProperty("pendingPlanFailed");
    }
    // Without a mark the same product is scheduled as before.
    await expect(
      adapter.aws.action("schedule_plan_change", ctx(null, { payload: { productId: NEXT } })),
    ).resolves.toMatchObject({ kind: "done" });
  });
});

// WPA-P2. The admin action that clears the failure mark: no AWS call, only the config patch.
describe("clear_plan_change_mark (admin, WPA-P2)", () => {
  const NEXT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("removes the failure mark and calls AWS not at all; the pending plan and the applied plan stay", async () => {
    const { adapter, ctx, calls } = setup();
    const r = await adapter.aws.action(
      "clear_plan_change_mark",
      ctx(null, {
        payload: { requestId: "r" },
        config: { pendingPlanFailed: { code: "conflict", productId: NEXT, period: null } },
      }),
    );
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { pendingPlanFailed: null } } });
    expect(
      Object.keys((r as unknown as { patch: { configMerge: object } }).patch.configMerge),
    ).toEqual(["pendingPlanFailed"]);
    expect(calls()).toEqual([]);
  });

  // WPU-M4: the credit of a failed apply drops the pending plan with the mark, so it is not re-applied.
  it("with clearPendingPlan it also drops the pending plan, but only the one the credited apply named", async () => {
    const { adapter, ctx, calls } = setup();
    const r = await adapter.aws.action(
      "clear_plan_change_mark",
      ctx(null, {
        payload: { requestId: "r", clearPendingPlan: true, productId: NEXT },
        config: {
          pendingPlan: { productId: NEXT },
          pendingPlanFailed: { code: "conflict", productId: NEXT, period: null },
        },
      }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { pendingPlanFailed: null, pendingPlan: null } },
    });
    expect(calls()).toEqual([]);
    // the customer scheduled another plan since: it stays
    const kept = await adapter.aws.action(
      "clear_plan_change_mark",
      ctx(null, {
        payload: { requestId: "r", clearPendingPlan: true, productId: NEXT },
        config: { pendingPlan: { productId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
      }),
    );
    expect(
      Object.keys((kept as unknown as { patch: { configMerge: object } }).patch.configMerge),
    ).toEqual(["pendingPlanFailed"]);
    // a flag without a product id drops nothing (fail closed)
    const bare = await adapter.aws.action(
      "clear_plan_change_mark",
      ctx(null, {
        payload: { clearPendingPlan: true },
        config: { pendingPlan: { productId: NEXT } },
      }),
    );
    expect(
      Object.keys((bare as unknown as { patch: { configMerge: object } }).patch.configMerge),
    ).toEqual(["pendingPlanFailed"]);
  });

  it("is a repeat-safe patch when the mark is already gone, and a destroyed resource is a conflict", async () => {
    const { adapter, ctx } = setup();
    await expect(
      adapter.aws.action("clear_plan_change_mark", ctx(null, { payload: {} })),
    ).resolves.toMatchObject({ kind: "done" });
    await expect(
      adapter.aws.action("clear_plan_change_mark", ctx(null, { payload: {}, state: "destroyed" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("deployment history (WPU-G8)", () => {
  it("keeps the last ten deployments as date, images and endpoint, never the environment", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "CreateContainerServiceDeployment", lightsailOk({}));
    const old = Array.from({ length: 10 }, (_, i) => ({
      at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`,
      images: [`img${i}`],
      endpoint: false,
    }));
    const r = await adapter.aws.action(
      "deploy_containers",
      ctx(null, {
        config: { deployments: old },
        payload: {
          containers: [{ image: "nginx", environment: { TOKEN: "s3cr3t-value" } }],
        },
      }),
    );
    expect(r.kind).toBe("done");
    const merge = (
      r as unknown as { patch: { configMerge: { deployments: { images: string[] }[] } } }
    ).patch.configMerge;
    expect(merge.deployments).toHaveLength(10);
    expect(merge.deployments[9]).toMatchObject({ images: ["nginx"], endpoint: false });
    expect(merge.deployments[0]).toMatchObject({ images: ["img1"] });
    expect(JSON.stringify(merge.deployments)).not.toContain("s3cr3t-value");
  });
});

describe("custom domain and certificate (WPU-G8)", () => {
  const CERT = awsResourceName("cert", RID);
  const issued = (extra: Record<string, unknown> = {}) =>
    lightsailOk({
      certificates: [
        {
          certificateName: CERT,
          certificateDetail: {
            name: CERT,
            domainName: "app.example.com",
            status: "ISSUED",
            domainValidationRecords: [
              {
                resourceRecord: {
                  name: "_x.app.example.com.",
                  type: "CNAME",
                  value: "_y.acm.aws.",
                },
              },
            ],
            ...extra,
          },
        },
      ],
    });

  it("request_certificate creates one certificate under a generated name for a checked domain", async () => {
    const { aws, adapter, ctx, body } = setup();
    aws.on("lightsail", "GetCertificates", notFound());
    aws.on("lightsail", "CreateCertificate", lightsailOk({}));
    const r = await adapter.aws.action(
      "request_certificate",
      ctx(null, { payload: { domain: "App.Example.com" } }),
    );
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          certificate: { domain: "app.example.com", status: "PENDING_VALIDATION", attached: false },
        },
      },
    });
    const create = body("CreateCertificate");
    expect(create).toMatchObject({ certificateName: CERT, domainName: "app.example.com" });
    expect(JSON.stringify(create.tags)).not.toContain("Secret");
    for (const bad of ["localhost", "*.example.com", 5, undefined]) {
      await expect(
        adapter.aws.action("request_certificate", ctx(null, { payload: { domain: bad } })),
      ).rejects.toMatchObject({ code: "validation" });
    }
  });

  it("a certificate that exists is not created again (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetCertificates", issued());
    await adapter.aws.action(
      "request_certificate",
      ctx(null, { payload: { domain: "app.example.com" } }),
    );
    expect(calls()).not.toContain("CreateCertificate");
  });

  it("refresh_certificate stores the validation records and attaches an issued certificate once", async () => {
    const { aws, adapter, ctx, body, service } = setup();
    aws.on("lightsail", "GetCertificates", issued());
    aws.on("lightsail", "GetContainerServices", service("RUNNING"));
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    const r = await adapter.aws.action("refresh_certificate", ctx(null));
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          certificate: {
            domain: "app.example.com",
            status: "ISSUED",
            attached: true,
            records: [{ name: "_x.app.example.com.", type: "CNAME", value: "_y.acm.aws." }],
          },
        },
      },
    });
    expect(body("UpdateContainerService")).toEqual({
      serviceName: SERVICE,
      publicDomainNames: { [CERT]: ["app.example.com"] },
    });
  });

  it("a pending certificate is only recorded, an attached one is not attached again, none is refused", async () => {
    const pending = setup();
    pending.aws.on("lightsail", "GetCertificates", issued({ status: "PENDING_VALIDATION" }));
    const r = await pending.adapter.aws.action("refresh_certificate", pending.ctx(null));
    expect(r).toMatchObject({
      patch: { configMerge: { certificate: { status: "PENDING_VALIDATION", attached: false } } },
    });
    expect(pending.calls()).not.toContain("UpdateContainerService");

    const attached = setup();
    attached.aws.on("lightsail", "GetCertificates", issued());
    attached.aws.on(
      "lightsail",
      "GetContainerServices",
      attached.service("RUNNING", { publicDomainNames: { [CERT]: ["app.example.com"] } }),
    );
    await attached.adapter.aws.action("refresh_certificate", attached.ctx(null));
    expect(attached.calls()).not.toContain("UpdateContainerService");

    const none = setup();
    none.aws.on("lightsail", "GetCertificates", notFound());
    await expect(
      none.adapter.aws.action("refresh_certificate", none.ctx(null)),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("remove and replace the certificate (WPU-G11)", () => {
  const CERT = awsResourceName("cert", RID);
  const attached = { publicDomainNames: { [CERT]: ["app.example.com"] } };

  it("remove_certificate takes the domain off the service, deletes the certificate and clears the saved one", async () => {
    const { aws, adapter, ctx, body, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("RUNNING", attached));
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    const r = await adapter.aws.action("remove_certificate", ctx(null));
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { certificate: null } } });
    expect(calls()).toEqual([
      "GetContainerServices",
      "UpdateContainerService",
      "DeleteCertificate",
    ]);
    expect(body("UpdateContainerService")).toEqual({
      serviceName: awsResourceName("container", RID),
      publicDomainNames: {},
    });
    expect(body("DeleteCertificate")).toEqual({ certificateName: CERT });
  });

  it("a service without the domain only has the certificate deleted; a gone certificate is clean (R7)", async () => {
    const loose = setup();
    loose.aws.on("lightsail", "GetContainerServices", loose.service("RUNNING"));
    loose.aws.on("lightsail", "DeleteCertificate", notFound());
    const r = await loose.adapter.aws.action("remove_certificate", loose.ctx(null));
    expect(loose.calls()).not.toContain("UpdateContainerService");
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { certificate: null } } });
  });

  it("replace_certificate removes the old one and requests the new domain under the same generated name", async () => {
    const { aws, adapter, ctx, body, calls, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("RUNNING", attached));
    aws.on("lightsail", "UpdateContainerService", lightsailOk({}));
    aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    aws.on("lightsail", "GetCertificates", notFound());
    aws.on("lightsail", "CreateCertificate", lightsailOk({}));
    const r = await adapter.aws.action(
      "replace_certificate",
      ctx(null, { payload: { domain: "New.Example.com" } }),
    );
    expect(r).toMatchObject({
      patch: {
        configMerge: {
          certificate: { domain: "new.example.com", status: "PENDING_VALIDATION", attached: false },
        },
      },
    });
    expect(calls().filter((c) => c !== "GetCertificates")).toEqual([
      "GetContainerServices",
      "UpdateContainerService",
      "DeleteCertificate",
      "CreateCertificate",
    ]);
    expect(body("CreateCertificate")).toMatchObject({
      certificateName: CERT,
      domainName: "new.example.com",
    });
  });

  it("refuses a bad new domain before any call, a service it cannot read, and a certificate that still shows", async () => {
    const bad = setup();
    for (const domain of ["*.x.com", "localhost", "", null, 7]) {
      await expect(
        bad.adapter.aws.action("replace_certificate", bad.ctx(null, { payload: { domain } })),
      ).rejects.toMatchObject({ code: "validation" });
    }
    expect(bad.aws.seen.length).toBe(0);

    const unread = setup();
    unread.aws.on("lightsail", "GetContainerServices", lightsailOk({ containerServices: [] }));
    await expect(
      unread.adapter.aws.action("remove_certificate", unread.ctx(null)),
    ).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    expect(unread.calls()).not.toContain("DeleteCertificate");

    const slow = setup();
    slow.aws.on("lightsail", "GetContainerServices", slow.service("RUNNING"));
    slow.aws.on("lightsail", "DeleteCertificate", lightsailOk({}));
    slow.aws.on(
      "lightsail",
      "GetCertificates",
      lightsailOk({
        certificates: [
          {
            certificateName: CERT,
            certificateDetail: { name: CERT, domainName: "old.example.com", status: "ISSUED" },
          },
        ],
      }),
    );
    await expect(
      slow.adapter.aws.action(
        "replace_certificate",
        slow.ctx(null, { payload: { domain: "new.example.com" } }),
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(slow.calls()).not.toContain("CreateCertificate");
  });
});

describe("no registry login is ever issued", () => {
  it("no step of any method calls CreateContainerServiceRegistryLogin or sets private registry access", async () => {
    const { aws, adapter, ctx, service } = setup();
    aws.on("lightsail", "GetContainerServices", service("READY"));
    for (const call of [
      () => adapter.aws.create(ctx(null)),
      () => adapter.aws.create(ctx("wait_ready")),
      () => adapter.aws.create(ctx("deploy", { config: { deployment: DEPLOYMENT } })),
      () => adapter.aws.create(ctx("wait_deploy")),
      () => adapter.aws.suspend(ctx(null)),
      () => adapter.aws.resume(ctx(null)),
      () => adapter.aws.destroy(ctx(null, { state: "suspended" })),
      () => adapter.aws.describe(ctx(null)),
      () => adapter.aws.action("deploy_containers", ctx(null, { payload: DEPLOYMENT })),
      () =>
        adapter.aws.action(
          "scale_container",
          ctx(null, {
            payload: { productId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...APPLY },
          }),
        ),
    ]) {
      await call().catch(() => undefined);
    }
    const seen = aws.seen.filter((r) => r.service === "lightsail");
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.map((r) => r.action)).not.toContain("CreateContainerServiceRegistryLogin");
    expect(seen.map((r) => r.body).join("\n")).not.toMatch(
      /privateRegistryAccess|ecrImagePullerRole/,
    );
  });

  it("the source of this package never names the command or the private registry access", () => {
    const dir = join(import.meta.dirname, "..", "adapters");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/CreateContainerServiceRegistryLogin/);
      expect(text, file).not.toMatch(/privateRegistryAccess/);
    }
  });
});
