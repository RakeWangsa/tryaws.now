import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createLinuxInstanceAdapter } from "../adapters/linux-instance";
import { DESTROY_WAIT_MS } from "../adapters/shared";
import type { OpCtx } from "../adapters/types";
import { createWindowsInstanceAdapter } from "../adapters/windows-instance";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-Y4. A server is destroyed with its disks. Lightsail: "Deleting an instance doesn't delete its ... attached
// disks" and the disks "remain in Lightsail, and incur additional charges" (user guide, read 2026-11-14); DeleteDisk
// needs a disk that is not attached and DetachDisk a stopped instance (API reference). The page never says that a
// delete of the instance detaches its disks, so the server's destroy never relies on it (R16): while a block storage
// disk is attached it stops the server and waits, bounded, until the disks' own destroys have detached them, and
// only then sends DeleteInstance.

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const OTHER_OP = "22345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const INSTANCE = awsResourceName("instance", RID);
const DISK = awsResourceName("disk", "44444444-5555-4666-8777-888888888888");
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

const SYSTEM = { name: "sda", isSystemDisk: true, path: "/dev/sda1" };
const EXTRA = { name: DISK, isSystemDisk: false, path: "/dev/xvdf" };
const instance = (state: string, disks: unknown[] | null = [SYSTEM]) =>
  lightsailOk({
    instance: {
      name: INSTANCE,
      state: { name: state },
      hardware: disks === null ? {} : { cpuCount: 2, disks },
    },
  });
const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

function setup(family: "linux" | "windows", config: Record<string, unknown> = {}) {
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
  const common = {
    vpcCidr: async () => "172.26.0.0/16",
    bootstrapMarker: async () => "present" as const,
  };
  const adapter =
    family === "linux"
      ? createLinuxInstanceAdapter({ loadLaunch: async () => null, ...common })
      : createWindowsInstanceAdapter({ loadLaunch: async () => null, ...common });
  const parsed = adapter.parseConfig({
    productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    region: "ap-southeast-1",
    displayName: "web",
    keyPairId: null,
  });
  const ctx = (step: string | null): OpCtx<typeof parsed> => ({
    operation: {
      id: OP_ID,
      kind: "destroy",
      step,
      attempt: 1,
      // Approved two days after it was queued: the approval wait is not the bound of the disk wait.
      createdAt: new Date(NOW - 2 * 86_400_000),
      payload: {},
    },
    stepKey: `${OP_ID}:${step ?? "start"}`,
    resource: {
      id: RID,
      customerId: CID,
      family: family === "linux" ? "linux_instance" : "windows_instance",
      productId: null,
      parentResourceId: null,
      awsName: INSTANCE,
      state: "suspended",
      config,
    },
    config: parsed,
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: async () => null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls };
}

describe("server destroy with attached disks (WPU-Y4)", () => {
  it("no block storage disk: straight to DeleteInstance, the server is not stopped", async () => {
    const { aws, adapter, ctx, calls } = setup("linux");
    aws.on("lightsail", "GetInstance", instance("running"));
    expect(await adapter.aws.destroy(ctx(null))).toEqual({ kind: "next", step: "delete_instance" });
    aws.on("lightsail", "DeleteInstance", lightsailOk({ operations: [] }));
    expect(await adapter.aws.destroy(ctx("delete_instance"))).toEqual({
      kind: "next",
      step: "release_ip",
    });
    expect(calls()).toEqual(["GetInstance", "DeleteInstance"]);
  });

  it("an instance that is gone goes on to the delete (not found is done)", async () => {
    const { aws, adapter, ctx } = setup("linux");
    aws.on("lightsail", "GetInstance", notFound());
    expect(await adapter.aws.destroy(ctx(null))).toEqual({ kind: "next", step: "delete_instance" });
  });

  it("a running server with a disk is stopped, then waits: no DeleteInstance", async () => {
    const { aws, adapter, ctx, calls } = setup("linux");
    aws.on("lightsail", "GetInstance", instance("running", [SYSTEM, EXTRA]));
    aws.on("lightsail", "StopInstance", lightsailOk({ operations: [] }));
    const r = await adapter.aws.destroy(ctx(null));
    expect(r).toMatchObject({
      kind: "wait",
      step: "release_disks",
      patch: {
        configMerge: { destroyWait: { operationId: OP_ID, since: new Date(NOW).toISOString() } },
      },
    });
    expect(JSON.parse(aws.seen.find((q) => q.action === "StopInstance")!.body)).toEqual({
      instanceName: INSTANCE,
    });
    expect(calls()).not.toContain("DeleteInstance");
  });

  it("a stopping or stopped server with a disk only waits (no second StopInstance)", async () => {
    for (const state of ["stopping", "stopped"]) {
      const { aws, adapter, ctx, calls } = setup("linux");
      aws.on("lightsail", "GetInstance", instance(state, [SYSTEM, EXTRA]));
      expect(await adapter.aws.destroy(ctx("release_disks"))).toMatchObject({
        kind: "wait",
        step: "release_disks",
      });
      expect(calls()).toEqual(["GetInstance"]);
    }
  });

  it("once the disks are detached it deletes the instance", async () => {
    const since = new Date(NOW - 120_000).toISOString();
    const { aws, adapter, ctx } = setup("linux", { destroyWait: { operationId: OP_ID, since } });
    aws.on("lightsail", "GetInstance", instance("stopped", [SYSTEM]));
    expect(await adapter.aws.destroy(ctx("release_disks"))).toEqual({
      kind: "next",
      step: "delete_instance",
    });
  });

  it("the wait is bounded from its own first wait; past it the destroy is a conflict", async () => {
    const old = new Date(NOW - DESTROY_WAIT_MS - 1).toISOString();
    const { aws, adapter, ctx, calls } = setup("linux", {
      destroyWait: { operationId: OP_ID, since: old },
    });
    aws.on("lightsail", "GetInstance", instance("stopped", [SYSTEM, EXTRA]));
    await expect(adapter.aws.destroy(ctx("release_disks"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(calls()).not.toContain("DeleteInstance");
  });

  it("a mark of another operation starts a new wait", async () => {
    const old = new Date(NOW - DESTROY_WAIT_MS - 1).toISOString();
    const { aws, adapter, ctx } = setup("linux", {
      destroyWait: { operationId: OTHER_OP, since: old },
    });
    aws.on("lightsail", "GetInstance", instance("stopped", [SYSTEM, EXTRA]));
    expect(await adapter.aws.destroy(ctx("release_disks"))).toMatchObject({
      kind: "wait",
      patch: { configMerge: { destroyWait: { operationId: OP_ID } } },
    });
  });

  it("an answer without the disk list is a conflict (R16): the delete never runs blind", async () => {
    const { aws, adapter, ctx, calls } = setup("linux");
    aws.on("lightsail", "GetInstance", instance("stopped", null));
    await expect(adapter.aws.destroy(ctx(null))).rejects.toMatchObject({ code: "conflict" });
    expect(calls()).not.toContain("DeleteInstance");
  });

  it("a Windows server follows the same rule", async () => {
    const { aws, adapter, ctx, calls } = setup("windows");
    aws.on("lightsail", "GetInstance", instance("running", [SYSTEM, EXTRA]));
    aws.on("lightsail", "StopInstance", lightsailOk({ operations: [] }));
    expect(await adapter.aws.destroy(ctx(null))).toMatchObject({
      kind: "wait",
      step: "release_disks",
    });
    expect(calls()).toEqual(["GetInstance", "StopInstance"]);
  });
});
