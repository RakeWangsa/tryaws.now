import { generateKeyPairSync } from "node:crypto";
import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { BOOTSTRAP_BEACON_PORT, bootstrapScript } from "../adapters/bootstrap";
import { createLinuxInstanceAdapter, type LinuxInstanceDeps } from "../adapters/linux-instance";
import type { OpCtx } from "../adapters/types";
import { AwsError } from "../errors";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KID = "99999999-8888-4777-8666-555555555555";
const OID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const INSTANCE = awsResourceName("instance", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
// WPU-Y5 (e): ImportKeyPair takes ssh-rsa keys only, so the stored line is an OpenSSH ssh-rsa line (no comment).
function rsaLine(bits: number): string {
  const jwk = generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({
    format: "jwk",
  });
  const field = (b: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(b.length);
    return Buffer.concat([head, b]);
  };
  const mpint = (b: Buffer) => field((b[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
  const e = Buffer.from(jwk.e as string, "base64url");
  const n = Buffer.from(jwk.n as string, "base64url");
  const blob = Buffer.concat([field(Buffer.from("ssh-rsa")), mpint(e), mpint(n)]);
  return `ssh-rsa ${blob.toString("base64")}`;
}
const PUBLIC_KEY = rsaLine(2048);

function setup(over: Partial<LinuxInstanceDeps> = {}) {
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
  const deps: LinuxInstanceDeps = {
    loadLaunch: async (input) => {
      launchCalls.push(input);
      return { bundleId: "nano_3_0", blueprintId: "ubuntu_24_04", publicKey: PUBLIC_KEY };
    },
    vpcCidr: async () => "172.26.0.0/16",
    bootstrapMarker: async () => "present",
    ...over,
  };
  const adapter = createLinuxInstanceAdapter(deps);
  const ctx = (
    step: string | null,
    extra: { payload?: unknown; config?: unknown; createdAt?: Date; blueprintId?: string } = {},
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
      family: "linux_instance",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: extra.config ?? {},
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "My Secret Server",
      keyPairId: KID,
      ...(extra.blueprintId === undefined ? {} : { blueprintId: extra.blueprintId }),
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

// WPU-G3: the image the customer chose reaches the launch lookup, with the Region; none = the default.
describe("the image of the order", () => {
  it("asks for the chosen image in the Region of the server, in the key step and in the create step", async () => {
    const launchCalls: unknown[] = [];
    const { aws, adapter, ctx } = setup({
      loadLaunch: async (input) => {
        launchCalls.push(input);
        return {
          bundleId: "nano_3_0",
          blueprintId: input.blueprintId ?? "ubuntu_24_04",
          publicKey: PUBLIC_KEY,
        };
      },
    });
    aws.on("lightsail", "GetKeyPair", lightsailError(400, "NotFoundException", "x"));
    aws.on("lightsail", "ImportKeyPair", lightsailOk({}));
    aws.on("lightsail", "GetInstance", lightsailError(400, "NotFoundException", "x"));
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    await adapter.aws.create(ctx(null, { blueprintId: "wordpress" }));
    await adapter.aws.create(ctx("create_instance", { blueprintId: "wordpress" }));
    expect(launchCalls).toHaveLength(2);
    for (const call of launchCalls) {
      expect(call).toMatchObject({ blueprintId: "wordpress", region: "ap-southeast-1" });
    }
    const create = aws.seen.find((r) => r.action === "CreateInstances")!;
    expect(JSON.parse(create.body)).toMatchObject({ blueprintId: "wordpress" });
  });

  it("an order without an image asks with null, and the lookup decides the default", async () => {
    const { aws, adapter, ctx, launchCalls } = setup();
    aws.on("lightsail", "GetInstance", lightsailError(400, "NotFoundException", "x"));
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    await adapter.aws.create(ctx("create_instance"));
    expect(launchCalls[0]).toMatchObject({ blueprintId: null });
    const create = aws.seen.find((r) => r.action === "CreateInstances")!;
    expect(JSON.parse(create.body)).toMatchObject({ blueprintId: "ubuntu_24_04" });
  });
});

const notFound = () => lightsailError(400, "NotFoundException", "raw aws text 210987654321");

describe("create: key import, instance, static IP, ports", () => {
  it("walks the steps and names everything from the resource id (R11)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetKeyPair", notFound());
    aws.on("lightsail", "ImportKeyPair", lightsailOk({}));
    aws.on("lightsail", "GetInstance", notFound());
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    const r1 = await adapter.aws.create(ctx(null));
    expect(r1).toMatchObject({ kind: "next", step: "create_instance" });
    const imp = aws.seen.find((r) => r.action === "ImportKeyPair")!;
    expect(JSON.parse(imp.body)).toEqual({
      keyPairName: awsResourceName("keypair", KID),
      publicKeyBase64: Buffer.from(PUBLIC_KEY).toString("base64"),
    });
    const r2 = await adapter.aws.create(ctx("create_instance"));
    expect(r2).toMatchObject({ kind: "next", step: "wait_running", patch: { awsName: INSTANCE } });
    const create = JSON.parse(aws.seen.find((r) => r.action === "CreateInstances")!.body);
    expect(create.instanceNames).toEqual([INSTANCE]);
    expect(create.userData).toBe(bootstrapScript({ vpcCidr: "172.26.0.0/16" }));
    expect(create.userData).not.toContain("My Secret Server");
    expect(create.keyPairName).toBe(awsResourceName("keypair", KID));
    expect(create.ipAddressType).toBe("ipv4");
    expect(create.tags).toEqual(
      expect.arrayContaining([
        { key: "tc:resource", value: RID },
        { key: "tc:customer", value: CID },
        { key: "tc:order", value: OID },
        { key: "tc:os", value: "linux" },
      ]),
    );
    // customer text reaches nothing of AWS
    expect(aws.seen.map((r) => r.body).join("\n")).not.toContain("My Secret Server");
    expect(calls()).not.toContain("DownloadDefaultKeyPair");
  });

  it("a retried create_instance finds the instance and creates nothing (R7)", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: INSTANCE, tags: [{ key: "tc:resource", value: RID }] } }),
    );
    const r = await adapter.aws.create(ctx("create_instance"));
    expect(r).toMatchObject({ kind: "next", step: "wait_running" });
    expect(calls()).toEqual(["GetInstance"]);
  });

  it("an instance of that name that is not ours is a conflict, not a continuation", async () => {
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

  it("an existing key pair is not imported again", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetKeyPair", lightsailOk({ keyPair: { name: "x" } }));
    await adapter.aws.create(ctx("import_key"));
    expect(calls()).toEqual(["GetKeyPair"]);
  });

  it("WPU-Y5: refuses a key ImportKeyPair does not take (not ssh-rsa, or under 2048 bits) before any AWS call", async () => {
    for (const publicKey of [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEYFORTESTS",
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=",
      rsaLine(1024),
      `${PUBLIC_KEY} customer@laptop`,
    ]) {
      const bad = setup({
        loadLaunch: async () => ({ bundleId: "b", blueprintId: "p", publicKey }),
      });
      await expect(
        bad.adapter.aws.create(bad.ctx(null)),
        publicKey.slice(0, 20),
      ).rejects.toMatchObject({
        code: "validation",
        retryable: false,
      });
      expect(bad.calls()).toEqual([]);
    }
  });

  it("fails closed without a key, or when the key is not the customer's (loader says null)", async () => {
    const none = setup({
      loadLaunch: async () => ({ bundleId: "b", blueprintId: "p", publicKey: null }),
    });
    await expect(none.adapter.aws.create(none.ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
    expect(none.calls()).toEqual([]);
    const gone = setup({ loadLaunch: async () => null });
    await expect(gone.adapter.aws.create(gone.ctx("create_instance"))).rejects.toBeInstanceOf(
      AwsError,
    );
    expect(gone.calls()).toEqual([]);
  });

  it("asks for the key with the customer id of the resource row, never the payload (R8)", async () => {
    const { aws, adapter, ctx, launchCalls } = setup();
    aws.on("lightsail", "GetKeyPair", lightsailOk({ keyPair: {} }));
    await adapter.aws.create(ctx("import_key", { payload: { orderId: OID, customerId: "evil" } }));
    expect(launchCalls).toEqual([
      {
        customerId: CID,
        productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        keyPairId: KID,
        blueprintId: null,
        region: "ap-southeast-1",
      },
    ]);
  });

  it("waits while pending, continues when running, bounds its own waiting", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { state: { name: "pending" } } }));
    const w = await adapter.aws.create(ctx("wait_running"));
    expect(w).toMatchObject({ kind: "wait", step: "wait_running" });
    await expect(
      adapter.aws.create(ctx("wait_running", { createdAt: new Date(NOW - 3_600_000) })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { state: { name: "running" } } }));
    expect(await adapter.aws.create(ctx("wait_running"))).toEqual({
      kind: "next",
      step: "verify_bootstrap",
    });
  });

  it("WPU-Z19: stores the login user GetInstance reports (username), only a plain user name", async () => {
    const { aws, adapter, ctx } = setup();
    const running = (username: unknown) =>
      lightsailOk({ instance: { state: { name: "running" }, username } });
    aws.on("lightsail", "GetInstance", running("admin"));
    expect(await adapter.aws.create(ctx("wait_running"))).toEqual({
      kind: "next",
      step: "verify_bootstrap",
      patch: { configMerge: { loginUser: "admin" } },
    });
    for (const bad of ["Root", "a b", "x".repeat(40), 7]) {
      aws.on("lightsail", "GetInstance", running(bad));
      expect(await adapter.aws.create(ctx("wait_running"))).toEqual({
        kind: "next",
        step: "verify_bootstrap",
      });
    }
  });

  const RUNNING = lightsailOk({
    instance: { name: INSTANCE, publicIpAddress: "52.220.10.20", state: { name: "running" } },
  });
  const wired = (over: Partial<LinuxInstanceDeps> = {}) => {
    const probes: unknown[] = [];
    const s = setup({
      beaconSources: async () => ["203.0.113.5/32"],
      bootstrapMarker: async (input) => {
        probes.push(input);
        return "present";
      },
      ...over,
    });
    s.aws.on("lightsail", "GetInstance", RUNNING);
    s.aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({ operation: {} }));
    return { ...s, probes };
  };

  it("never hands over an instance whose bootstrap has no marker (no static IP is touched)", async () => {
    const absent = wired({ bootstrapMarker: async () => "absent" });
    await expect(absent.adapter.aws.create(absent.ctx("verify_bootstrap"))).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    expect(absent.calls()).not.toContain("AllocateStaticIp");
    const pending = wired({ bootstrapMarker: async () => "pending" });
    expect(await pending.adapter.aws.create(pending.ctx("verify_bootstrap"))).toMatchObject({
      kind: "wait",
      step: "verify_bootstrap",
    });
    const ok = wired();
    expect(await ok.adapter.aws.create(ok.ctx("verify_bootstrap"))).toMatchObject({
      kind: "next",
      step: "allocate_ip",
    });
  });

  it("WPU-G1: opens only the beacon port to the probe sources next to the default rules, then reads the marker from the public address", async () => {
    const { aws, adapter, ctx, probes } = wired();
    await adapter.aws.create(ctx("verify_bootstrap"));
    const put = JSON.parse(aws.seen.find((r) => r.action === "PutInstancePublicPorts")!.body);
    expect(put.instanceName).toBe(INSTANCE);
    expect(put.portInfos).toEqual([
      { fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
      {
        fromPort: BOOTSTRAP_BEACON_PORT,
        toPort: BOOTSTRAP_BEACON_PORT,
        protocol: "tcp",
        cidrs: ["203.0.113.5/32"],
      },
    ]);
    expect(probes).toEqual([
      { instanceName: INSTANCE, region: "ap-southeast-1", publicIp: "52.220.10.20" },
    ]);
  });

  it("WPU-G1: the final port set drops the beacon rule again", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({ operation: {} }));
    await adapter.aws.create(ctx("open_ports"));
    const put = JSON.parse(aws.seen.find((r) => r.action === "PutInstancePublicPorts")!.body);
    expect(put.portInfos).toEqual([
      { fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
    ]);
  });

  it("WPU-G1: waits while the instance has no public address, without touching the firewall", async () => {
    const s = wired();
    s.aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { name: INSTANCE, state: { name: "running" } } }),
    );
    expect(await s.adapter.aws.create(s.ctx("verify_bootstrap"))).toMatchObject({
      kind: "wait",
      step: "verify_bootstrap",
    });
    expect(s.calls()).toEqual(["GetInstance"]);
    expect(s.probes).toEqual([]);
  });

  it("WPU-G1: fails closed when the probe sources are not configured, and opens nothing", async () => {
    for (const none of [null, []] as const) {
      const s = wired({ beaconSources: async () => none });
      await expect(s.adapter.aws.create(s.ctx("verify_bootstrap"))).rejects.toMatchObject({
        code: "internal",
      });
      expect(s.calls()).not.toContain("PutInstancePublicPorts");
      expect(s.probes).toEqual([]);
    }
  });

  it("WPU-G1: fails closed when the instance is stopped or gone while waiting for the marker", async () => {
    const s = wired();
    s.aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({
        instance: { name: INSTANCE, publicIpAddress: "52.220.10.20", state: { name: "stopped" } },
      }),
    );
    await expect(s.adapter.aws.create(s.ctx("verify_bootstrap"))).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    expect(s.probes).toEqual([]);
  });

  it("WPU-G1: a marker that never shows is bounded by the wait budget, then refused (R16)", async () => {
    const s = wired({ bootstrapMarker: async () => "pending" });
    await expect(
      s.adapter.aws.create(s.ctx("verify_bootstrap", { createdAt: new Date(NOW - 3_600_000) })),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("WPU-G1: a retry of the step repeats the same calls and changes nothing else (R7)", async () => {
    const s = wired();
    const a = await s.adapter.aws.create(s.ctx("verify_bootstrap"));
    const b = await s.adapter.aws.create(s.ctx("verify_bootstrap"));
    expect(b).toEqual(a);
    expect(s.calls().filter((c) => c === "AllocateStaticIp")).toEqual([]);
  });

  it("allocates once, attaches to its own instance, refuses an address attached elsewhere", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { name: "n" } }));
    await adapter.aws.create(ctx("allocate_ip"));
    expect(calls()).toEqual(["GetStaticIp"]);

    const b = setup();
    b.aws.on("lightsail", "GetStaticIp", notFound());
    b.aws.on("lightsail", "AllocateStaticIp", lightsailOk({}));
    await b.adapter.aws.create(b.ctx("allocate_ip"));
    expect(b.calls()).toEqual(["GetStaticIp", "AllocateStaticIp"]);

    const c = setup();
    c.aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: false, ipAddress: "203.0.113.7" } }),
    );
    c.aws.on("lightsail", "AttachStaticIp", lightsailOk({}));
    const attachedNow = await c.adapter.aws.create(c.ctx("attach_ip"));
    expect(c.calls()).toEqual(["GetStaticIp", "AttachStaticIp", "GetStaticIp"]);
    // WPU-D3 (C.12): the address of the static IP is written to the resource config at create
    expect(attachedNow).toMatchObject({
      kind: "next",
      step: "open_ports",
      patch: { configMerge: { staticIpAttached: true, publicIpv4: "203.0.113.7" } },
    });

    const d = setup();
    d.aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({
        staticIp: { isAttached: true, attachedTo: INSTANCE, ipAddress: "203.0.113.8" },
      }),
    );
    const already = await d.adapter.aws.create(d.ctx("attach_ip"));
    expect(d.calls()).toEqual(["GetStaticIp"]);
    expect(already).toMatchObject({
      kind: "next",
      step: "open_ports",
      patch: { configMerge: { publicIpv4: "203.0.113.8" } },
    });

    // an address that is not a plain IPv4 is not written; the step still moves on
    const f = setup();
    f.aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    f.aws.on("lightsail", "AttachStaticIp", lightsailOk({}));
    const noAddress = await f.adapter.aws.create(f.ctx("attach_ip"));
    expect(noAddress).toMatchObject({ kind: "next", step: "open_ports" });
    expect(JSON.stringify(noAddress)).not.toContain("publicIpv4");

    const e = setup();
    e.aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: "tc-instance-other" } }),
    );
    await expect(e.adapter.aws.create(e.ctx("attach_ip"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("opens SSH only (IPv4) and finishes active", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({}));
    const r = await adapter.aws.create(ctx("open_ports"));
    expect(r).toMatchObject({ kind: "done", patch: { state: "active", awsName: INSTANCE } });
    expect(JSON.parse(aws.seen.find((x) => x.action === "PutInstancePublicPorts")!.body)).toEqual({
      instanceName: INSTANCE,
      portInfos: [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] }],
    });
  });

  it("an unknown VPC CIDR gives user data that drops every private source", async () => {
    const { aws, adapter, ctx } = setup({ vpcCidr: async () => null });
    aws.on("lightsail", "GetInstance", notFound());
    aws.on("lightsail", "CreateInstances", lightsailOk({ operations: [] }));
    await adapter.aws.create(ctx("create_instance"));
    const body = JSON.parse(aws.seen.find((r) => r.action === "CreateInstances")!.body);
    expect(body.userData).toContain("{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } drop");
  });

  it("an unknown step is refused", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.create(ctx("whatever"))).rejects.toBeInstanceOf(AwsError);
  });
});

describe("parseConfig", () => {
  it("rejects bad input without echoing it", () => {
    const { adapter } = setup();
    expect(() => adapter.parseConfig({ productId: "no" })).toThrow(AwsError);
  });
});

describe("suspend, resume, snapshot, destroy, actions", () => {
  it("suspend saves the open rules, then closes with an empty list; resume puts them back", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetInstancePortStates",
      lightsailOk({
        portStates: [
          { fromPort: 22, toPort: 22, protocol: "tcp", state: "open", cidrs: ["0.0.0.0/0"] },
          { fromPort: 80, toPort: 80, protocol: "tcp", state: "closed", cidrs: [] },
        ],
      }),
    );
    const saved = await adapter.aws.suspend(ctx(null));
    expect(saved).toMatchObject({
      kind: "next",
      step: "close_ports",
      patch: {
        configMerge: {
          savedPorts: [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] }],
        },
      },
    });
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({}));
    const closed = await adapter.aws.suspend(ctx("close_ports"));
    expect(closed).toMatchObject({ kind: "done", patch: { state: "suspended" } });
    expect(
      JSON.parse(aws.seen.find((x) => x.action === "PutInstancePublicPorts")!.body).portInfos,
    ).toEqual([]);

    const savedPorts = [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] }];
    const r = await adapter.aws.resume(ctx(null, { config: { savedPorts } }));
    expect(r).toMatchObject({ kind: "done", patch: { state: "active" } });
    expect(
      JSON.parse(aws.seen.filter((x) => x.action === "PutInstancePublicPorts")[1]!.body).portInfos,
    ).toEqual(savedPorts);
  });

  it("a retried suspend never saves the empty list over the saved rules", async () => {
    const { adapter, ctx, calls } = setup();
    const savedPorts = [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] }];
    const r = await adapter.aws.suspend(ctx("save_ports", { config: { savedPorts } }));
    expect(r).toMatchObject({ kind: "next", step: "close_ports" });
    expect(calls()).toEqual([]);
  });

  it("resume without saved rules fails closed", async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.aws.resume(ctx(null))).rejects.toMatchObject({ code: "validation" });
  });

  it("final snapshot creates once and waits until available", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetInstanceSnapshot", notFound());
    aws.on("lightsail", "CreateInstanceSnapshot", lightsailOk({}));
    expect(await adapter.aws.finalSnapshot(ctx(null))).toMatchObject({ kind: "wait" });
    expect(calls()).toEqual(["GetInstanceSnapshot", "CreateInstanceSnapshot"]);
    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({ instanceSnapshot: { state: "pending" } }),
    );
    expect(await adapter.aws.finalSnapshot(ctx("wait_snapshot"))).toMatchObject({ kind: "wait" });
    aws.on(
      "lightsail",
      "GetInstanceSnapshot",
      lightsailOk({ instanceSnapshot: { state: "available" } }),
    );
    expect(await adapter.aws.finalSnapshot(ctx("wait_snapshot"))).toMatchObject({ kind: "done" });
  });

  it("destroy treats not-found as done and releases the static IP", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "DeleteInstance", notFound());
    expect(await adapter.aws.destroy(ctx(null))).toMatchObject({
      kind: "next",
      step: "release_ip",
    });
    aws.on("lightsail", "ReleaseStaticIp", notFound());
    expect(await adapter.aws.destroy(ctx("release_ip"))).toMatchObject({
      kind: "done",
      patch: { state: "destroyed" },
    });
  });

  it("purgeSnapshots treats not-found as done", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "DeleteInstanceSnapshot", notFound());
    expect(await adapter.aws.purgeSnapshots(ctx(null))).toMatchObject({ kind: "done" });
  });

  it("describe reports the live state, or `missing`", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: { state: { name: "running" } } }));
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "running" });
    aws.on("lightsail", "GetInstance", notFound());
    expect(await adapter.aws.describe(ctx(null))).toEqual({ state: "missing" });
  });

  it("reboot, stop, start work; set_ports validates its payload; other kinds are refused", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "RebootInstance", lightsailOk({}));
    aws.on("lightsail", "StopInstance", lightsailOk({}));
    aws.on("lightsail", "StartInstance", lightsailOk({}));
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({}));
    expect(await adapter.aws.action("reboot", ctx(null))).toMatchObject({ kind: "done" });
    expect(await adapter.aws.action("stop", ctx(null))).toMatchObject({
      patch: { state: "stopped" },
    });
    expect(await adapter.aws.action("start", ctx(null))).toMatchObject({
      patch: { state: "active" },
    });
    const ok = { ports: [{ fromPort: 443, toPort: 443, protocol: "tcp", cidrs: ["10.0.0.0/8"] }] };
    expect(await adapter.aws.action("set_ports", ctx(null, { payload: ok }))).toMatchObject({
      kind: "done",
      // The saved list is what the Networking tab shows (WPU-G17).
      patch: { configMerge: { firewallRules: ok.ports } },
    });
    for (const bad of [
      { ports: [{ fromPort: 70000, toPort: 70000, protocol: "tcp", cidrs: ["0.0.0.0/0"] }] },
      { ports: [{ fromPort: 22, toPort: 22, protocol: "gre", cidrs: ["0.0.0.0/0"] }] },
      { ports: [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["$(id)"] }] },
      { ports: [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["999.1.1.1/8"] }] },
      { ports: "all" },
    ]) {
      await expect(
        adapter.aws.action("set_ports", ctx(null, { payload: bad })),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(adapter.aws.action("snapshot" as OperationKind, ctx(null))).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("set_ports sends ping as an ICMP rule and an empty list closes everything", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "PutInstancePublicPorts", lightsailOk({}));
    const ping = { fromPort: 8, toPort: -1, protocol: "icmp", cidrs: ["0.0.0.0/0"] };
    await adapter.aws.action("set_ports", ctx(null, { payload: { ports: [ping] } }));
    await adapter.aws.action("set_ports", ctx(null, { payload: { ports: [] } }));
    const puts = aws.seen.filter((x) => x.action === "PutInstancePublicPorts");
    expect(JSON.parse(puts[0]!.body).portInfos).toEqual([ping]);
    expect(JSON.parse(puts[1]!.body).portInfos).toEqual([]);
  });

  it("rename changes the display name only: no call to AWS, and the name is checked again", async () => {
    const { adapter, ctx, calls } = setup();
    const done = await adapter.aws.action(
      "rename",
      ctx(null, { payload: { displayName: " web-2 " } }),
    );
    expect(done).toMatchObject({ kind: "done", patch: { configMerge: { displayName: "web-2" } } });
    expect(calls()).toEqual([]);
    for (const bad of [
      {},
      { displayName: "" },
      { displayName: "a<b>" },
      { displayName: 7 },
      null,
    ]) {
      await expect(adapter.aws.action("rename", ctx(null, { payload: bad }))).rejects.toMatchObject(
        { code: "validation" },
      );
    }
  });

  it("attach_static_ip attaches the server's own static IP and records its address", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    aws.on("lightsail", "AttachStaticIp", lightsailOk({}));
    const done = await adapter.aws.action("attach_static_ip", ctx(null));
    expect(done).toMatchObject({
      kind: "done",
      patch: { configMerge: { staticIpAttached: true } },
    });
    expect(calls()).toEqual(["GetStaticIp", "AttachStaticIp", "GetStaticIp"]);
    const attach = JSON.parse(aws.seen.find((x) => x.action === "AttachStaticIp")!.body);
    expect(attach).toEqual({
      staticIpName: awsResourceName("staticip", RID),
      instanceName: INSTANCE,
    });
  });

  it("attach_static_ip records the address of the IP and is a no-op when already attached", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({
        staticIp: { isAttached: true, attachedTo: INSTANCE, ipAddress: "203.0.113.9" },
      }),
    );
    const done = await adapter.aws.action("attach_static_ip", ctx(null));
    expect(done).toMatchObject({
      kind: "done",
      patch: { configMerge: { staticIpAttached: true, publicIpv4: "203.0.113.9" } },
    });
    expect(calls()).toEqual(["GetStaticIp"]);
  });

  it("attach_static_ip never touches an IP that is attached to another instance (R16)", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: "tc-instance-other" } }),
    );
    await expect(adapter.aws.action("attach_static_ip", ctx(null))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("attach_static_ip allocates the IP again if it is gone", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on("lightsail", "GetStaticIp", notFound());
    aws.on("lightsail", "AllocateStaticIp", lightsailOk({}));
    aws.on("lightsail", "AttachStaticIp", lightsailOk({}));
    await adapter.aws.action("attach_static_ip", ctx(null));
    expect(calls()).toEqual(["GetStaticIp", "AllocateStaticIp", "AttachStaticIp", "GetStaticIp"]);
  });

  it("WPU-M1: a detach stamps detachedAt with the clock; an attach clears it", async () => {
    const { aws, adapter, ctx } = setup();
    aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: INSTANCE } }),
    );
    aws.on("lightsail", "DetachStaticIp", lightsailOk({}));
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: {} }));
    expect(await adapter.aws.action("detach_static_ip", ctx(null))).toMatchObject({
      patch: { configMerge: { staticIpAttached: false, detachedAt: new Date(NOW).toISOString() } },
    });

    const att = setup();
    att.aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    att.aws.on("lightsail", "AttachStaticIp", lightsailOk({}));
    expect(await att.adapter.aws.action("attach_static_ip", att.ctx(null))).toMatchObject({
      patch: { configMerge: { staticIpAttached: true, detachedAt: null } },
    });
    const already = setup();
    already.aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: INSTANCE } }),
    );
    expect(await already.adapter.aws.action("attach_static_ip", already.ctx(null))).toMatchObject({
      patch: { configMerge: { staticIpAttached: true, detachedAt: null } },
    });
  });

  it("WPU-M1: a repeated detach keeps the first detachedAt, so the free hour is not restarted", async () => {
    const first = "2026-11-12T08:00:00.000Z";
    const { aws, adapter, ctx } = setup();
    aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    aws.on("lightsail", "GetInstance", lightsailOk({ instance: {} }));
    expect(
      await adapter.aws.action(
        "detach_static_ip",
        ctx(null, { config: { staticIpAttached: false, detachedAt: first } }),
      ),
    ).toMatchObject({ patch: { configMerge: { detachedAt: first } } });
    // A value that is not an exact instant is replaced by the clock.
    const bad = setup();
    bad.aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    bad.aws.on("lightsail", "GetInstance", lightsailOk({ instance: {} }));
    expect(
      await bad.adapter.aws.action(
        "detach_static_ip",
        bad.ctx(null, { config: { detachedAt: "yesterday" } }),
      ),
    ).toMatchObject({ patch: { configMerge: { detachedAt: new Date(NOW).toISOString() } } });
  });

  it("detach_static_ip detaches only an IP attached to this instance; not-found is done", async () => {
    const { aws, adapter, ctx, calls } = setup();
    aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: INSTANCE } }),
    );
    aws.on("lightsail", "DetachStaticIp", lightsailOk({}));
    aws.on(
      "lightsail",
      "GetInstance",
      lightsailOk({ instance: { publicIpAddress: "198.51.100.4" } }),
    );
    const done = await adapter.aws.action("detach_static_ip", ctx(null));
    // The instance has its own address again: the tab must not keep showing the static one.
    expect(done).toMatchObject({
      kind: "done",
      patch: { configMerge: { staticIpAttached: false, publicIpv4: "198.51.100.4" } },
    });
    expect(calls()).toEqual(["GetStaticIp", "DetachStaticIp", "GetInstance"]);

    const again = setup();
    again.aws.on("lightsail", "GetStaticIp", lightsailOk({ staticIp: { isAttached: false } }));
    again.aws.on("lightsail", "GetInstance", lightsailOk({ instance: {} }));
    expect(await again.adapter.aws.action("detach_static_ip", again.ctx(null))).toMatchObject({
      kind: "done",
      patch: { configMerge: { staticIpAttached: false, publicIpv4: null } },
    });
    expect(again.calls()).toEqual(["GetStaticIp", "GetInstance"]);

    const other = setup();
    other.aws.on(
      "lightsail",
      "GetStaticIp",
      lightsailOk({ staticIp: { isAttached: true, attachedTo: "tc-instance-other" } }),
    );
    await expect(
      other.adapter.aws.action("detach_static_ip", other.ctx(null)),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
