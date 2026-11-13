import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createDiskAdapter } from "../adapters/disk";
import { DESTROY_WAIT_MS } from "../adapters/shared";
import type { OpCtx, ResourceView } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-Y4. A disk destroyed because its server is destroyed (the payload names the server: `withServer`). The disk
// waits, bounded, for the server's own destroy to stop the server; only then is it detached and deleted. DeleteDisk
// needs a disk that is not attached and DetachDisk needs a stopped instance (Lightsail API reference, read 2026-11-14).

const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DISK_ID = "44444444-5555-4666-8777-888888888888";
const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-2222-4333-8444-666666666666";
const SUB_ID = "33333333-2222-4333-8444-555555555555";
const OP_ID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DISK = awsResourceName("disk", DISK_ID);
const SERVER = awsResourceName("instance", SERVER_ID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const TAG = [{ key: "tc:resource", value: DISK_ID }];

const attached = (to = SERVER) =>
  lightsailOk({
    disk: { name: DISK, state: "in-use", isAttached: true, attachedTo: to, tags: TAG },
  });
const detached = () =>
  lightsailOk({ disk: { name: DISK, state: "available", isAttached: false, tags: TAG } });
const serverIn = (state: string) =>
  lightsailOk({ instance: { name: SERVER, state: { name: state } } });

function view(over: Partial<ResourceView> & { id: string }): ResourceView {
  return {
    customerId: CID,
    family: "linux_instance",
    productId: null,
    parentResourceId: null,
    awsName: null,
    state: "active",
    config: {},
    ...over,
  };
}

function setup(diskConfig: Record<string, unknown> = {}) {
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
  const store = new Map<string, ResourceView>([[SERVER_ID, view({ id: SERVER_ID })]]);
  const adapter = createDiskAdapter({
    listBackups: async () => [],
    ensureFinalBackup: async () => ({ id: OP_ID }),
    markFinalBackup: async () => undefined,
  });
  const config = adapter.parseConfig({
    productId: null,
    region: "ap-southeast-1",
    displayName: "data",
    sizeGb: 32,
  });
  const ctx = (
    step: string | null,
    payload: unknown = { subscriptionId: SUB_ID, withServer: SERVER_ID },
  ): OpCtx<typeof config> => ({
    operation: {
      id: OP_ID,
      kind: "destroy",
      step,
      attempt: 1,
      createdAt: new Date(NOW - 3 * 86_400_000),
      payload,
    },
    stepKey: `${OP_ID}:${step ?? "start"}`,
    resource: view({
      id: DISK_ID,
      family: "disk",
      config: {
        region: "ap-southeast-1",
        sizeGb: 32,
        attachedInstanceId: SERVER_ID,
        ...diskConfig,
      },
    }),
    config,
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: async (id) => store.get(id) ?? null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  return { aws, adapter, ctx, calls, store };
}

describe("disk destroy with its server (WPU-Y4)", () => {
  it("waits for the server's destroy to stop the server: no DetachDisk, a wait mark is written", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("running"));
    const r = await adapter.aws.destroy(ctx(null));
    expect(r).toMatchObject({
      kind: "wait",
      step: "wait_server",
      patch: {
        configMerge: { destroyWait: { operationId: OP_ID, since: new Date(NOW).toISOString() } },
      },
    });
    expect(calls().filter((n) => n === "DetachDisk" || n === "DeleteDisk")).toEqual([]);
  });

  it("an operation that waited long ago for approval still waits: the bound runs from its own first wait", async () => {
    // createdAt is three days back (an approval queue); MAX_WAIT_MS of 20 minutes must not end it.
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("stopping"));
    expect(await adapter.aws.destroy(ctx(null))).toMatchObject({
      kind: "wait",
      step: "wait_server",
    });
  });

  it("once the server is stopped it detaches, then deletes", async () => {
    const since = new Date(NOW - 60_000).toISOString();
    const { aws, adapter, ctx } = setup({ destroyWait: { operationId: OP_ID, since } });
    aws.on("lightsail", "GetDisk", attached(), detached());
    aws.on("lightsail", "GetInstance", serverIn("stopped"));
    aws.on("lightsail", "DetachDisk", lightsailOk({ operations: [] }));
    expect(await adapter.aws.destroy(ctx("wait_server"))).toMatchObject({
      kind: "wait",
      step: "wait_detached",
    });
    expect(await adapter.aws.destroy(ctx("wait_detached"))).toMatchObject({
      kind: "next",
      step: "delete_disk",
    });
    aws.on("lightsail", "DeleteDisk", lightsailOk({ operations: [] }));
    expect(await adapter.aws.destroy(ctx("delete_disk"))).toEqual({
      kind: "done",
      patch: { state: "destroyed" },
    });
  });

  it("a second wait keeps the first mark (no patch) until the bound, then it is a conflict", async () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const a = setup({ destroyWait: { operationId: OP_ID, since: recent } });
    a.aws.on("lightsail", "GetDisk", attached());
    a.aws.on("lightsail", "GetInstance", serverIn("running"));
    const r = await a.adapter.aws.destroy(a.ctx("wait_server"));
    expect(r).toMatchObject({ kind: "wait", step: "wait_server" });
    expect("patch" in r).toBe(false);

    const old = new Date(NOW - DESTROY_WAIT_MS - 1).toISOString();
    const b = setup({ destroyWait: { operationId: OP_ID, since: old } });
    b.aws.on("lightsail", "GetDisk", attached());
    b.aws.on("lightsail", "GetInstance", serverIn("running"));
    await expect(b.adapter.aws.destroy(b.ctx("wait_server"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(b.calls().filter((n) => n === "DetachDisk" || n === "DeleteDisk")).toEqual([]);
  });

  it("a mark of another operation is not this one's: it starts its own", async () => {
    const old = new Date(NOW - DESTROY_WAIT_MS - 1).toISOString();
    const { aws, adapter, ctx } = setup({ destroyWait: { operationId: OTHER_ID, since: old } });
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("running"));
    expect(await adapter.aws.destroy(ctx(null))).toMatchObject({
      kind: "wait",
      patch: { configMerge: { destroyWait: { operationId: OP_ID } } },
    });
  });

  it("a mark that cannot be read is a conflict (R16)", async () => {
    const { aws, adapter, ctx } = setup({ destroyWait: { operationId: OP_ID, since: "soon" } });
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("running"));
    await expect(adapter.aws.destroy(ctx("wait_server"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses when the disk is attached to another server than the payload names", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetDisk", attached(awsResourceName("instance", OTHER_ID)));
    aws.on("lightsail", "GetInstance", serverIn("stopped"));
    await expect(adapter.aws.destroy(ctx(null))).rejects.toMatchObject({ code: "conflict" });
    expect(calls().filter((n) => n === "DetachDisk" || n === "DeleteDisk")).toEqual([]);
  });

  it("refuses a server that is not the customer's (R8): ctx.owned answers null", async () => {
    const { aws, adapter, ctx, store, calls } = setup();
    store.delete(SERVER_ID);
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("stopped"));
    await expect(adapter.aws.destroy(ctx(null))).rejects.toMatchObject({ code: "conflict" });
    expect(calls().filter((n) => n === "DetachDisk" || n === "DeleteDisk")).toEqual([]);
  });

  it("refuses a payload whose withServer is not an id", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", attached());
    await expect(
      adapter.aws.destroy(ctx(null, { subscriptionId: SUB_ID, withServer: "tc-instance-x" })),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("the server is gone (its destroy ran first): an attached answer is still a conflict, a detached disk is deleted", async () => {
    const a = setup();
    a.aws.on("lightsail", "GetDisk", attached());
    a.aws.on("lightsail", "GetInstance", lightsailError(400, "NotFoundException", "gone"));
    await expect(a.adapter.aws.destroy(a.ctx(null))).rejects.toMatchObject({ code: "conflict" });

    const b = setup();
    b.aws.on("lightsail", "GetDisk", detached());
    expect(await b.adapter.aws.destroy(b.ctx(null))).toMatchObject({
      kind: "next",
      step: "delete_disk",
    });
  });

  it("without withServer the WPU-Z19 rule is unchanged: a running server is a conflict at once", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetDisk", attached());
    aws.on("lightsail", "GetInstance", serverIn("running"));
    await expect(adapter.aws.destroy(ctx(null, { subscriptionId: SUB_ID }))).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
