import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createLoadBalancerAdapter } from "../adapters/load-balancer";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const T1 = "99999999-8888-4777-8666-555555555555";
const T2 = "77777777-8888-4777-8666-333333333333";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const LB = awsResourceName("lb", RID);
const I1 = awsResourceName("instance", T1);
const I2 = awsResourceName("instance", T2);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

const instance = (id: string, over: Partial<ResourceView> = {}): ResourceView => ({
  id,
  customerId: CID,
  family: "linux_instance",
  productId: null,
  parentResourceId: null,
  awsName: null,
  state: "active",
  config: { region: "ap-southeast-1" },
  ...over,
});

function setup(rows: Record<string, ResourceView> = {}, resourceConfig: unknown = {}) {
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
  const adapter = createLoadBalancerAdapter();
  const owned = async (id: string) => rows[id] ?? null;
  const ctx = (
    step: string | null,
    extra: {
      kind?: OperationKind;
      targetIds?: string[];
      createdAt?: Date;
      payload?: unknown;
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
      family: "load_balancer",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: resourceConfig,
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret LB",
      targetIds: extra.targetIds ?? [T1, T2],
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
const lb = (state: string, tags: unknown[] = [{ key: "tc:resource", value: RID }]) =>
  lightsailOk({ loadBalancer: { name: LB, state, tags } });
const OWN = { [T1]: instance(T1), [T2]: instance(T2) };

describe("create", () => {
  it("creates one load balancer on port 80 with a generated name (R11, R7)", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(OWN);
    aws.on("lightsail", "GetLoadBalancer", notFound());
    aws.on("lightsail", "CreateLoadBalancer", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_active", patch: { awsName: LB } });
    expect(bodyOf("CreateLoadBalancer")).toMatchObject({ loadBalancerName: LB, instancePort: 80 });
    expect(aws.seen.map((x) => x.body).join("\n")).not.toContain("My Secret LB");
    // a retried step finds it
    const again = setup(OWN);
    again.aws.on("lightsail", "GetLoadBalancer", lb("provisioning"));
    await again.adapter.aws.create(again.ctx("create_lb"));
    expect(again.calls()).toEqual(["GetLoadBalancer"]);
    const foreign = setup(OWN);
    foreign.aws.on(
      "lightsail",
      "GetLoadBalancer",
      lb("active", [{ key: "tc:resource", value: "x" }]),
    );
    await expect(foreign.adapter.aws.create(foreign.ctx("create_lb"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("waits until active, then attaches only the targets that pass the rule and exist in AWS", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(OWN);
    aws.on("lightsail", "GetLoadBalancer", lb("provisioning"));
    expect(await adapter.aws.create(ctx("wait_active"))).toMatchObject({ kind: "wait" });
    aws.on("lightsail", "GetLoadBalancer", lb("active"));
    expect(await adapter.aws.create(ctx("wait_active"))).toMatchObject({
      kind: "next",
      step: "attach_targets",
    });
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { name: I1 } }));
    aws.on("lightsail", "AttachInstancesToLoadBalancer", lightsailOk({ operations: [] }));
    expect(await adapter.aws.create(ctx("attach_targets"))).toMatchObject({
      kind: "done",
      patch: { state: "active", awsName: LB },
    });
    expect(bodyOf("AttachInstancesToLoadBalancer")).toEqual({
      loadBalancerName: LB,
      instanceNames: [I1, I2],
    });
  });

  it("another customer's target, a missing one, another Region or a suspended one: nothing is attached (R8)", async () => {
    const bad: Record<string, ResourceView>[] = [
      { [T1]: instance(T1, { customerId: OTHER }), [T2]: instance(T2) },
      { [T2]: instance(T2) },
      { [T1]: instance(T1, { config: { region: "eu-west-1" } }), [T2]: instance(T2) },
      { [T1]: instance(T1, { state: "suspended" }), [T2]: instance(T2) },
    ];
    for (const rows of bad) {
      const { adapter, ctx, calls } = setup(rows);
      await expect(adapter.aws.create(ctx("attach_targets"))).rejects.toMatchObject({
        code: "validation",
      });
      expect(calls()).not.toContain("AttachInstancesToLoadBalancer");
    }
  });

  it("a target that AWS does not know in this account is refused (R16)", async () => {
    const { aws, adapter, ctx, calls } = setup(OWN);
    aws.on("lightsail", "GetInstance", notFound());
    await expect(adapter.aws.create(ctx("attach_targets"))).rejects.toMatchObject({
      code: "validation",
    });
    expect(calls()).not.toContain("AttachInstancesToLoadBalancer");
  });
});

describe("suspend, resume, destroy", () => {
  it("suspend detaches and remembers the list; resume re-checks and reattaches", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(OWN);
    aws.on("lightsail", "DetachInstancesFromLoadBalancer", lightsailOk({ operations: [] }));
    const s = await adapter.aws.suspend(ctx(null, { kind: "suspend" }));
    expect(s).toMatchObject({
      kind: "done",
      patch: { state: "suspended", configMerge: { savedTargetIds: [T1, T2] } },
    });
    expect(bodyOf("DetachInstancesFromLoadBalancer")).toEqual({
      loadBalancerName: LB,
      instanceNames: [I1, I2],
    });
    const again = setup(OWN, { savedTargetIds: [T1, T2] });
    again.aws.on("lightsail", "GetInstance", lightsailOk({ instance: { name: I1 } }));
    again.aws.on("lightsail", "AttachInstancesToLoadBalancer", lightsailOk({ operations: [] }));
    expect(await again.adapter.aws.resume(again.ctx(null, { kind: "resume" }))).toMatchObject({
      kind: "done",
      patch: { state: "active" },
    });
    // resume with a saved list that no longer passes the rule attaches nothing
    const gone = setup({ [T1]: instance(T1, { customerId: OTHER }) }, { savedTargetIds: [T1] });
    await expect(gone.adapter.aws.resume(gone.ctx(null, { kind: "resume" }))).rejects.toMatchObject(
      {
        code: "validation",
      },
    );
    expect(gone.calls()).not.toContain("AttachInstancesToLoadBalancer");
  });

  it("destroy deletes, not found is done; a load balancer has no snapshot", async () => {
    const { aws, adapter, ctx, bodyOf } = setup(OWN);
    aws.on("lightsail", "DeleteLoadBalancer", notFound());
    expect(await adapter.aws.destroy(ctx(null, { kind: "destroy" }))).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
    expect(bodyOf("DeleteLoadBalancer")).toEqual({ loadBalancerName: LB });
    expect(await adapter.aws.finalSnapshot(ctx(null))).toMatchObject({ kind: "done" });
    expect(await adapter.aws.purgeSnapshots(ctx(null))).toMatchObject({ kind: "done" });
  });

  it("describe reports the state; an unsupported action is refused (R16)", async () => {
    const { aws, adapter, ctx } = setup(OWN);
    aws.on("lightsail", "GetLoadBalancer", lb("active"));
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "active" });
    await expect(adapter.aws.action("reboot", ctx(null, { kind: "reboot" }))).rejects.toMatchObject(
      {
        code: "validation",
      },
    );
  });
});

describe("console actions (WPU-G7)", () => {
  const act = (
    h: ReturnType<typeof setup>,
    kind: OperationKind,
    payload: unknown,
    state = "active",
  ) => {
    const c = h.ctx(null, { kind, payload });
    return h.adapter.aws.action(kind, { ...c, resource: { ...c.resource, state } });
  };

  it("set_targets attaches the new own instance and detaches the one that left, by generated names (R8, R11)", async () => {
    const T3 = "55555555-8888-4777-8666-444444444444";
    const h = setup({ ...OWN, [T3]: instance(T3) });
    h.aws.on(
      "lightsail",
      "GetLoadBalancer",
      lightsailOk({
        loadBalancer: {
          name: LB,
          state: "active",
          instanceHealthSummary: [{ instanceName: I1 }, { instanceName: I2 }],
        },
      }),
    );
    h.aws.on("lightsail", "GetInstance", lightsailOk({ instance: { name: "x" } }));
    h.aws.on("lightsail", "AttachInstancesToLoadBalancer", lightsailOk({ operations: [] }));
    h.aws.on("lightsail", "DetachInstancesFromLoadBalancer", lightsailOk({ operations: [] }));
    const r = await act(h, "set_targets", { targetIds: [T1, T3] });
    expect(r).toMatchObject({ kind: "done", patch: { configMerge: { targetIds: [T1, T3] } } });
    expect(h.bodyOf("AttachInstancesToLoadBalancer")).toEqual({
      loadBalancerName: LB,
      instanceNames: [awsResourceName("instance", T3)],
    });
    expect(h.bodyOf("DetachInstancesFromLoadBalancer")).toEqual({
      loadBalancerName: LB,
      instanceNames: [I2],
    });
  });

  it("set_targets refuses another customer's instance, an empty or malformed list and a balancer that is not active", async () => {
    const foreign = setup({ ...OWN, [T2]: instance(T2, { customerId: OTHER }) });
    await expect(act(foreign, "set_targets", { targetIds: [T1, T2] })).rejects.toMatchObject({
      code: "validation",
    });
    expect(foreign.calls()).not.toContain("AttachInstancesToLoadBalancer");
    const h = setup(OWN);
    for (const payload of [null, {}, { targetIds: [] }, { targetIds: ["x"] }, { targetIds: "a" }]) {
      await expect(act(h, "set_targets", payload)).rejects.toMatchObject({ code: "validation" });
    }
    await expect(act(h, "set_targets", { targetIds: [T1] }, "suspended")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.calls()).toEqual([]);
  });

  it("set_lb_attributes sets the health check path and the HTTPS redirect, nothing else", async () => {
    const h = setup(OWN);
    h.aws.on("lightsail", "UpdateLoadBalancerAttribute", lightsailOk({ operations: [] }));
    const r = await act(h, "set_lb_attributes", {
      healthCheckPath: "/health.html",
      httpsRedirect: true,
    });
    expect(r).toMatchObject({
      kind: "done",
      patch: { configMerge: { healthCheckPath: "/health.html", httpsRedirect: true } },
    });
    const bodies = h.aws.seen
      .filter((x) => x.action === "UpdateLoadBalancerAttribute")
      .map((x) => JSON.parse(x.body));
    expect(bodies).toEqual([
      { loadBalancerName: LB, attributeName: "HealthCheckPath", attributeValue: "/health.html" },
      { loadBalancerName: LB, attributeName: "HttpsRedirectionEnabled", attributeValue: "true" },
    ]);
    for (const payload of [
      {},
      { healthCheckPath: "health?x=1" },
      { healthCheckPath: "/a b" },
      { httpsRedirect: "yes" },
      { healthCheckPath: "/" + "a".repeat(200) },
    ]) {
      await expect(act(setup(OWN), "set_lb_attributes", payload)).rejects.toMatchObject({
        code: "validation",
      });
    }
  });

  it("request_certificate creates one certificate with a generated name and keeps the validation records", async () => {
    const h = setup(OWN);
    h.aws.on("lightsail", "GetLoadBalancerTlsCertificates", lightsailOk({ tlsCertificates: [] }));
    h.aws.on("lightsail", "CreateLoadBalancerTlsCertificate", lightsailOk({ operations: [] }));
    const r = await act(h, "request_certificate", { domain: "Shop.Example.com" });
    expect(h.bodyOf("CreateLoadBalancerTlsCertificate")).toMatchObject({
      loadBalancerName: LB,
      certificateName: awsResourceName("lbcert", RID),
      certificateDomainName: "shop.example.com",
    });
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: { certificate: { domain: "shop.example.com", status: "PENDING_VALIDATION" } },
      },
    });
    for (const domain of [
      "",
      "localhost",
      "*.example.com",
      "a b.com",
      "-x.com",
      "x..com",
      5,
      "exa_mple.com",
    ]) {
      await expect(act(setup(OWN), "request_certificate", { domain })).rejects.toMatchObject({
        code: "validation",
      });
    }
  });

  it("refresh_certificate stores the status and records, and attaches the certificate once it is issued", async () => {
    const name = awsResourceName("lbcert", RID);
    const cert = (status: string) =>
      lightsailOk({
        tlsCertificates: [
          {
            name,
            domainName: "shop.example.com",
            status,
            isAttached: false,
            domainValidationRecords: [
              { name: "_x.shop.example.com.", type: "CNAME", value: "_y.acm-validations.aws." },
            ],
          },
        ],
      });
    const pending = setup(OWN);
    pending.aws.on("lightsail", "GetLoadBalancerTlsCertificates", cert("PENDING_VALIDATION"));
    const r1 = await act(pending, "refresh_certificate", {});
    expect(r1).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          certificate: {
            status: "PENDING_VALIDATION",
            records: [
              { name: "_x.shop.example.com.", type: "CNAME", value: "_y.acm-validations.aws." },
            ],
          },
        },
      },
    });
    expect(pending.calls()).toEqual(["GetLoadBalancerTlsCertificates"]);
    const issued = setup(OWN);
    issued.aws.on("lightsail", "GetLoadBalancerTlsCertificates", cert("ISSUED"));
    issued.aws.on("lightsail", "AttachLoadBalancerTlsCertificate", lightsailOk({ operations: [] }));
    const r2 = await act(issued, "refresh_certificate", {});
    expect(issued.bodyOf("AttachLoadBalancerTlsCertificate")).toEqual({
      loadBalancerName: LB,
      certificateName: name,
    });
    expect(r2).toMatchObject({
      kind: "done",
      patch: { configMerge: { certificate: { status: "ISSUED", attached: true } } },
    });
    const none = setup(OWN);
    none.aws.on(
      "lightsail",
      "GetLoadBalancerTlsCertificates",
      lightsailOk({ tlsCertificates: [] }),
    );
    await expect(act(none, "refresh_certificate", {})).rejects.toMatchObject({
      code: "validation",
    });
  });
});
