import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { windowsBootstrapScript } from "../adapters/bootstrap-windows";
import {
  createWindowsInstanceAdapter,
  type WindowsInstanceDeps,
} from "../adapters/windows-instance";
import type { OpCtx } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const INSTANCE = awsResourceName("instance", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

function setup(over: Partial<WindowsInstanceDeps> = {}) {
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
  const launchCalls: unknown[] = [];
  const deps: WindowsInstanceDeps = {
    loadLaunch: async (input) => {
      launchCalls.push(input);
      return { bundleId: "medium_win_3_0", blueprintId: "windows_server_2022" };
    },
    vpcCidr: async () => "172.26.0.0/16",
    bootstrapMarker: async () => "present",
    ...over,
  };
  const adapter = createWindowsInstanceAdapter(deps);
  const ctx = (
    step: string | null,
    extra: { payload?: unknown; createdAt?: Date } = {},
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
      family: "windows_instance",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: {},
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret Server",
      keyPairId: null,
    }),
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: async () => null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls, launchCalls };
}

const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

describe("windows create", () => {
  it("is the windows_instance family and needs no customer key", () => {
    const { adapter } = setup();
    expect(adapter.family).toBe("windows_instance");
  });

  it("creates from the Windows blueprint with the pool default key pair, a generated name and tc:os=windows (R11)", async () => {
    const { aws, adapter, ctx, launchCalls } = setup();
    aws.on("lightsail", "GetInstance", notFound());
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    const r = await adapter.aws.create(ctx(null));
    expect(r).toMatchObject({ kind: "next", step: "wait_running", patch: { awsName: INSTANCE } });
    const body = JSON.parse(aws.seen.find((x) => x.action === "CreateInstances")!.body);
    expect(body.instanceNames).toEqual([INSTANCE]);
    expect(body.blueprintId).toBe("windows_server_2022");
    expect(body.bundleId).toBe("medium_win_3_0");
    // no customer key pair: the pool's default one is used by leaving the name out
    expect(body.keyPairName).toBeUndefined();
    expect(body.userData).toBe(windowsBootstrapScript({ vpcCidr: "172.26.0.0/16" }));
    expect(body.ipAddressType).toBe("ipv4");
    expect(body.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: RID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: OID },
        { key: "tc:os", value: "windows" },
      ]),
    );
    expect(aws.seen.map((x) => x.body).join("\n")).not.toContain("My Secret Server");
    expect(aws.seen.map((x) => x.action)).not.toContain("DownloadDefaultKeyPair");
    expect(aws.seen.map((x) => x.action)).not.toContain("ImportKeyPair");
    expect(launchCalls).toEqual([
      { customerId: CID, productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]);
  });

  it("never adds the automatic snapshot add-on (not supported on Windows)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstance", notFound());
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    await adapter.aws.create(ctx(null));
    const body = JSON.parse(aws.seen.find((x) => x.action === "CreateInstances")!.body);
    expect(body.addOns).toBeUndefined();
  });

  it("a retry finds the instance by name and tag and creates nothing (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: INSTANCE, tags: [{ key: "tc:resource", value: RID }] } }),
    );
    expect(await adapter.aws.create(ctx("create_instance"))).toMatchObject({
      kind: "next",
      step: "wait_running",
    });
    expect(calls()).toEqual(["GetInstance"]);
  });

  it("an instance of that name that is not ours is a conflict", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: INSTANCE, tags: [{ key: "tc:resource", value: "other" }] } }),
    );
    await expect(adapter.aws.create(ctx("create_instance"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("fails closed when the launch spec is missing, before any call", async () => {
    const { adapter, ctx, calls } = setup({ loadLaunch: async () => null });
    await expect(adapter.aws.create(ctx(null))).rejects.toMatchObject({ code: "validation" });
    expect(calls()).toEqual([]);
  });

  it("does not hand over an instance without the bootstrap marker", async () => {
    const absent = setup({ bootstrapMarker: async () => "absent" });
    await expect(absent.adapter.aws.create(absent.ctx("verify_bootstrap"))).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    const pending = setup({ bootstrapMarker: async () => "pending" });
    expect(await pending.adapter.aws.create(pending.ctx("verify_bootstrap"))).toMatchObject({
      kind: "wait",
    });
    const ok = setup();
    expect(await ok.adapter.aws.create(ok.ctx("verify_bootstrap"))).toMatchObject({
      kind: "next",
      step: "allocate_ip",
    });
  });

  it("walks wait, address and ports, and opens RDP only (IPv4)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { state: { name: "running" } } }));
    expect(await adapter.aws.create(ctx("wait_running"))).toMatchObject({
      step: "verify_bootstrap",
    });
    aws.on("lightsail", "GetStaticIp", notFound());
    aws.on("lightsail", "AllocateStaticIp", lightsailOk({}));
    expect(await adapter.aws.create(ctx("allocate_ip"))).toMatchObject({ step: "attach_ip" });
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({}));
    const r = await adapter.aws.create(ctx("open_ports"));
    expect(r).toMatchObject({ kind: "done", patch: { state: "active", awsName: INSTANCE } });
    expect(JSON.parse(aws.seen.find((x) => x.action === "PutInstancePublicPorts")!.body)).toEqual({
      instanceName: INSTANCE,
      portInfos: [{ fromPort: 3389, toPort: 3389, protocol: "tcp", cidrs: ["0.0.0.0/0"] }],
    });
  });

  it("refuses a step it does not know", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.create(ctx("import_key"))).rejects.toMatchObject({
      code: "internal",
    });
  });
});

describe("windows lifecycle shares the instance rules", () => {
  it("destroys by generated name, treating not found as done", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "DeleteInstance", notFound());
    aws.on("lightsail", "ReleaseStaticIp", notFound());
    expect(await adapter.aws.destroy(ctx(null))).toMatchObject({ step: "release_ip" });
    expect(await adapter.aws.destroy(ctx("release_ip"))).toMatchObject({ kind: "done" });
  });

  it("describes a missing instance as missing", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstance", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });

  it("keeps the same final snapshot name as the other instance", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstanceSnapshot", notFound());
    aws.on("lightsail", "CreateInstanceSnapshot", lightsailOk({}));
    await adapter.aws.finalSnapshot(ctx(null));
    expect(
      JSON.parse(aws.seen.find((x) => x.action === "CreateInstanceSnapshot")!.body),
    ).toMatchObject({
      instanceName: INSTANCE,
      instanceSnapshotName: awsResourceName("snapshot", RID),
    });
  });
});
