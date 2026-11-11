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
      ctx(null, { payload: { productId: product } }),
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
        none.ctx(null, { payload: { productId: product } }),
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
          ctx(null, { payload: { productId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } }),
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
