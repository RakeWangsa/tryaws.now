import {
  AttachStaticIpCommand,
  AllocateStaticIpCommand,
  CreateInstanceSnapshotCommand,
  CreateInstancesCommand,
  DeleteInstanceCommand,
  DeleteInstanceSnapshotCommand,
  DetachStaticIpCommand,
  GetInstanceCommand,
  GetInstancePortStatesCommand,
  GetInstanceSnapshotCommand,
  GetKeyPairCommand,
  GetStaticIpCommand,
  ImportKeyPairCommand,
  PutInstancePublicPortsCommand,
  RebootInstanceCommand,
  ReleaseStaticIpCommand,
  StartInstanceCommand,
  StopInstanceCommand,
  type LightsailClient,
  type PortInfo,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  parseFirewallRules,
  parseInstanceConfig,
  parseServerDisplayName,
  resourceTags,
  stepDone,
  stepNext,
  stepWait,
  type InstanceConfig,
  type OperationKind,
  type StepResult,
} from "@tc/core";
import { AwsError } from "../errors";
import { BOOTSTRAP_BEACON_PORT, bootstrapScript } from "./bootstrap";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

/** A Linux user name as the panel puts it in an ssh command (the rule of sshCommandOf in @tc/core). */
const LOGIN_USER = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * What the adapter needs and OpCtx (contract F) does not carry: the OpCtx has no database. The
 * function that runs the adapter supplies it, with the customer id taken from the resource row and
 * never from a payload (R8). `publicKey` is null when the key does not exist or is not the
 * customer's: the create then fails closed (R16).
 */
export interface LinuxLaunchSpec {
  readonly bundleId: string;
  readonly blueprintId: string;
  readonly publicKey: string | null;
}
export interface LinuxInstanceDeps {
  loadLaunch(input: {
    readonly customerId: string;
    readonly productId: string;
    readonly keyPairId: string | null;
    /** WPU-G3: the image the customer chose; null for an order that has none (the default image). */
    readonly blueprintId: string | null;
    readonly region: string;
  }): Promise<LinuxLaunchSpec | null>;
  /**
   * Has the bootstrap printed its marker (BOOTSTRAP_OK_MARKER)? "pending" while the instance is still
   * running its user data, "absent" when it finished without the marker. The way to read it is a
   * VERIFY item (Lightsail has no console-output API; for example a probe from the platform). Without
   * the marker the instance is never handed over and its static IP is never attached (R16).
   */
  /**
   * The verified VPC CIDR of the pool account and Region, written into the user data as a literal.
   * null (unknown) makes the script drop every RFC 1918 source. Where it comes from is a VERIFY item
   * (a pool configuration row checked against the real network in tc-pool-dev).
   */
  vpcCidr(input: { readonly region: string }): Promise<string | null>;
  bootstrapMarker(input: {
    readonly instanceName: string;
    readonly region: string;
    /** WPU-G1: the public IPv4 address AWS reported for the instance, for the beacon probe. */
    readonly publicIp?: string | null;
  }): Promise<"present" | "pending" | "absent">;
  /**
   * WPU-G1. The public addresses the beacon probe connects from (checked CIDRs, see
   * parseProbeSources). The beacon port is opened to exactly these during `verify_bootstrap`; the
   * final port set removes the rule. null or empty = not configured: the create fails closed (R16)
   * and opens nothing. Absent = the dependency does not use the beacon (tests, the Windows adapter).
   */
  beaconSources?(input: { readonly region: string }): Promise<readonly string[] | null>;
}

const POLL_SECONDS = 10;
// An adapter bounds its own waiting (OpCtx.operation.createdAt).
const MAX_WAIT_MS = 20 * 60 * 1000;
const NO_RULES: readonly PortInfo[] = Object.freeze([]);
// The default after create: SSH only. IPv4 only until the IPv6 cases of tests/isolation hold (10.4).
const DEFAULT_PORTS: readonly PortInfo[] = Object.freeze([
  { fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
]);

function fail(code: "validation" | "conflict" | "upstream_unavailable" | "internal"): AwsError {
  return new AwsError({ code, retryable: false });
}

function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "not_found";
}

/** Runs a read that may find nothing: "not found" is `null`, any other error passes. */
async function orNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function client(ctx: OpCtx<InstanceConfig>): LightsailClient {
  return ctx.access.lightsail(ctx.account, ctx.region, "TcProvisioner");
}

function names(resourceId: string) {
  return {
    instance: awsResourceName("instance", resourceId),
    staticIp: awsResourceName("staticip", resourceId),
    snapshot: awsResourceName("snapshot", resourceId),
  };
}

function checkWaitBudget(ctx: OpCtx<InstanceConfig>): void {
  if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
    throw fail("upstream_unavailable");
  }
}

function pollAt(ctx: OpCtx<InstanceConfig>): Date {
  return new Date(ctx.clock.now().getTime() + POLL_SECONDS * 1000);
}

function hasTag(
  tags: readonly { key?: string; value?: string }[] | undefined,
  key: string,
  value: string,
) {
  return (tags ?? []).some((t) => t.key === key && t.value === value);
}

/**
 * The port rules of a `set_ports` payload or of the rules saved at suspend: validated again here
 * (the payload is input, R9). The one strict check lives in @tc/core, next to the form that builds
 * the list. IPv4 only (see DEFAULT_PORTS).
 */
export function parsePortRules(input: unknown): PortInfo[] | null {
  const rules = parseFirewallRules(input);
  if (rules === null) return null;
  return rules.map((r) => ({
    fromPort: r.fromPort,
    toPort: r.toPort,
    protocol: r.protocol,
    cidrs: [...r.cidrs],
  }));
}

function savedRules(ctx: OpCtx<InstanceConfig>): PortInfo[] | null {
  const config = ctx.resource.config;
  if (typeof config !== "object" || config === null) return null;
  return parsePortRules((config as Record<string, unknown>).savedPorts);
}

export function createLinuxInstanceAdapter(
  deps: LinuxInstanceDeps,
): ProductAdapter<InstanceConfig> {
  async function importKey(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    if (ctx.config.keyPairId === null) throw fail("validation");
    const spec = await deps.loadLaunch({
      customerId: ctx.resource.customerId,
      productId: ctx.config.productId,
      keyPairId: ctx.config.keyPairId,
      blueprintId: ctx.config.blueprintId ?? null,
      region: ctx.region,
    });
    if (spec === null || spec.publicKey === null) throw fail("validation");
    const keyName = awsResourceName("keypair", ctx.config.keyPairId);
    const lightsail = client(ctx);
    const existing = await orNull(() =>
      lightsail.send(new GetKeyPairCommand({ keyPairName: keyName })),
    );
    if (existing === null) {
      await lightsail.send(
        new ImportKeyPairCommand({
          keyPairName: keyName,
          publicKeyBase64: Buffer.from(spec.publicKey, "utf8").toString("base64"),
        }),
      );
    }
    return stepNext("create_instance");
  }

  async function createInstance(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    if (ctx.config.keyPairId === null) throw fail("validation");
    const spec = await deps.loadLaunch({
      customerId: ctx.resource.customerId,
      productId: ctx.config.productId,
      keyPairId: ctx.config.keyPairId,
      blueprintId: ctx.config.blueprintId ?? null,
      region: ctx.region,
    });
    if (spec === null) throw fail("validation");
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetInstanceCommand({ instanceName: n.instance })),
    );
    if (found?.instance !== undefined) {
      // A retry continues with what an earlier try made, if it is ours.
      if (!hasTag(found.instance.tags, "tc:resource", ctx.resource.id)) throw fail("conflict");
      return stepNext("wait_running", { awsName: n.instance });
    }
    const orderId = (ctx.operation.payload as { orderId?: unknown } | null)?.orderId;
    await lightsail.send(
      new CreateInstancesCommand({
        instanceNames: [n.instance],
        availabilityZone: `${ctx.region}a`,
        blueprintId: spec.blueprintId,
        bundleId: spec.bundleId,
        keyPairName: awsResourceName("keypair", ctx.config.keyPairId),
        userData: bootstrapScript({ vpcCidr: await deps.vpcCidr({ region: ctx.region }) }),
        ipAddressType: "ipv4",
        tags: resourceTags({
          env: ctx.env,
          customerId: ctx.resource.customerId,
          resourceId: ctx.resource.id,
          orderId: orderId as string,
          os: "linux",
        }),
      }),
    );
    return stepNext("wait_running", { awsName: n.instance });
  }

  async function waitRunning(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const got = await client(ctx).send(new GetInstanceCommand({ instanceName: n.instance }));
    const state = got.instance?.state?.name;
    if (state === "running") {
      // WPU-Z19: GetInstance `username` is the user for SSH ("The user name for connecting to the instance"); the
      // panel shows it instead of guessing from the image id (a Bitnami image logs in as bitnami, a
      // Lightsail-packaged app as admin). Only a plain user name is kept; anything else is left out.
      const user = got.instance?.username;
      return typeof user === "string" && LOGIN_USER.test(user)
        ? stepNext("verify_bootstrap", { configMerge: { loginUser: user } })
        : stepNext("verify_bootstrap");
    }
    if (state === "pending" || state === undefined) {
      checkWaitBudget(ctx);
      return stepWait("wait_running", pollAt(ctx));
    }
    throw fail("upstream_unavailable");
  }

  async function verifyBootstrap(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const got = await lightsail.send(new GetInstanceCommand({ instanceName: n.instance }));
    const state = got.instance?.state?.name;
    // A stopped or vanished instance after the script ran is not a firewall we proved (R16).
    if (state !== undefined && state !== "running" && state !== "pending") {
      throw fail("upstream_unavailable");
    }
    const publicIp = got.instance?.publicIpAddress ?? null;
    if (publicIp === null || state !== "running") {
      checkWaitBudget(ctx);
      return stepWait("verify_bootstrap", pollAt(ctx));
    }
    if (deps.beaconSources !== undefined) {
      const sources = await deps.beaconSources({ region: ctx.region });
      // Nothing is opened to an unknown source: the probe cannot work, so the create stops.
      if (sources === null || sources.length === 0) throw fail("internal");
      // Idempotent: the same full rule set on every poll (the default rules plus the beacon rule).
      await lightsail.send(
        new PutInstancePublicPortsCommand({
          instanceName: n.instance,
          portInfos: [
            ...DEFAULT_PORTS,
            {
              fromPort: BOOTSTRAP_BEACON_PORT,
              toPort: BOOTSTRAP_BEACON_PORT,
              protocol: "tcp",
              cidrs: [...sources],
            },
          ],
        }),
      );
    }
    const seen = await deps.bootstrapMarker({
      instanceName: n.instance,
      region: ctx.region,
      publicIp,
    });
    if (seen === "present") return stepNext("allocate_ip");
    if (seen === "pending") {
      checkWaitBudget(ctx);
      return stepWait("verify_bootstrap", pollAt(ctx));
    }
    // No marker: the firewall is not proven, so the instance is not handed over.
    throw fail("upstream_unavailable");
  }

  async function allocateIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
    );
    if (found === null)
      await lightsail.send(new AllocateStaticIpCommand({ staticIpName: n.staticIp }));
    return stepNext("attach_ip");
  }

  async function attachIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const got = await lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp }));
    const attached = got.staticIp?.attachedTo;
    let address = ipOf(got.staticIp?.ipAddress);
    if (got.staticIp?.isAttached === true) {
      // Attached to our own instance: done. To anything else: not ours to touch (R16).
      if (attached !== n.instance) throw fail("conflict");
    } else {
      await lightsail.send(
        new AttachStaticIpCommand({ staticIpName: n.staticIp, instanceName: n.instance }),
      );
      // WPU-D3 (audit C.12): the address of the static IP is the one the customer connects to; it is
      // read again after the attach and written to the resource config, as the attach action does.
      const now = await orNull(() =>
        lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
      );
      address = ipOf(now?.staticIp?.ipAddress) ?? address;
    }
    return stepNext("open_ports", {
      configMerge: { staticIpAttached: true, ...(address === null ? {} : { publicIpv4: address }) },
    });
  }

  async function openPorts(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    await client(ctx).send(
      new PutInstancePublicPortsCommand({
        instanceName: n.instance,
        portInfos: [...DEFAULT_PORTS],
      }),
    );
    return stepDone({ state: "active", awsName: n.instance });
  }

  async function create(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    switch (ctx.operation.step) {
      case null:
      case "import_key":
        return importKey(ctx);
      case "create_instance":
        return createInstance(ctx);
      case "wait_running":
        return waitRunning(ctx);
      case "verify_bootstrap":
        return verifyBootstrap(ctx);
      case "allocate_ip":
        return allocateIp(ctx);
      case "attach_ip":
        return attachIp(ctx);
      case "open_ports":
        return openPorts(ctx);
      default:
        throw fail("internal");
    }
  }

  // Suspend: save the rules, then close every public port (VERIFY: an empty list closes them all).
  async function suspend(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    if (ctx.operation.step === null || ctx.operation.step === "save_ports") {
      // A retry after the close must not save the empty list over the real one.
      if (savedRules(ctx) !== null) return stepNext("close_ports");
      const states = await lightsail.send(
        new GetInstancePortStatesCommand({ instanceName: n.instance }),
      );
      const rules = (states.portStates ?? [])
        .filter((p) => p.state === "open")
        .map((p) => ({
          fromPort: p.fromPort as number,
          toPort: p.toPort as number,
          protocol: p.protocol as string,
          cidrs: [...(p.cidrs ?? [])],
        }));
      const checked = parsePortRules(rules);
      if (checked === null) throw fail("validation");
      return stepNext("close_ports", { configMerge: { savedPorts: checked } });
    }
    if (ctx.operation.step === "close_ports") {
      await lightsail.send(
        new PutInstancePublicPortsCommand({ instanceName: n.instance, portInfos: [...NO_RULES] }),
      );
      return stepDone({ state: "suspended" });
    }
    throw fail("internal");
  }

  async function resume(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const rules = savedRules(ctx);
    if (rules === null) throw fail("validation");
    await client(ctx).send(
      new PutInstancePublicPortsCommand({
        instanceName: names(ctx.resource.id).instance,
        portInfos: rules,
      }),
    );
    return stepDone({ state: "active" });
  }

  async function finalSnapshot(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: n.snapshot })),
    );
    if (found === null) {
      await lightsail.send(
        new CreateInstanceSnapshotCommand({
          instanceName: n.instance,
          instanceSnapshotName: n.snapshot,
        }),
      );
      return stepWait("wait_snapshot", pollAt(ctx));
    }
    const state = found.instanceSnapshot?.state;
    if (state === "available") return stepDone();
    if (state === "error") throw fail("upstream_unavailable");
    checkWaitBudget(ctx);
    return stepWait("wait_snapshot", pollAt(ctx));
  }

  async function destroy(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    if (ctx.operation.step === null || ctx.operation.step === "delete_instance") {
      try {
        await lightsail.send(new DeleteInstanceCommand({ instanceName: n.instance }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return stepNext("release_ip");
    }
    if (ctx.operation.step === "release_ip") {
      try {
        await lightsail.send(new ReleaseStaticIpCommand({ staticIpName: n.staticIp }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return stepDone({ state: "destroyed" });
    }
    throw fail("internal");
  }

  async function purgeSnapshots(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    try {
      await client(ctx).send(
        new DeleteInstanceSnapshotCommand({
          instanceSnapshotName: names(ctx.resource.id).snapshot,
        }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return stepDone();
  }

  async function describe(ctx: OpCtx<InstanceConfig>): Promise<LiveState> {
    const got = await orNull(() =>
      client(ctx).send(new GetInstanceCommand({ instanceName: names(ctx.resource.id).instance })),
    );
    return { state: got?.instance?.state?.name ?? "missing" };
  }

  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  const ipOf = (value: string | undefined): string | null =>
    typeof value === "string" && IPV4.test(value) ? value : null;

  /**
   * WPU-G18: attaches the server's own static IP (the one `create` allocated, named after the
   * resource). Allocated again if it is gone; never touched if it is attached to anything else (R16).
   */
  async function attachOwnStaticIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
    );
    if (found?.staticIp?.isAttached === true) {
      // Attached to our own instance: done. To anything else: not ours to touch (R16).
      if (found.staticIp.attachedTo !== n.instance) throw fail("conflict");
      return stepDone({
        configMerge: {
          staticIpAttached: true,
          // WPU-M1: attached again, the charge for an unattached IP stops.
          detachedAt: null,
          ...(ipOf(found.staticIp.ipAddress) === null
            ? {}
            : { publicIpv4: ipOf(found.staticIp.ipAddress) }),
        },
      });
    }
    if (found === null) {
      await lightsail.send(new AllocateStaticIpCommand({ staticIpName: n.staticIp }));
    }
    await lightsail.send(
      new AttachStaticIpCommand({ staticIpName: n.staticIp, instanceName: n.instance }),
    );
    const now = await orNull(() =>
      lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
    );
    const address = ipOf(now?.staticIp?.ipAddress);
    return stepDone({
      configMerge: {
        staticIpAttached: true,
        detachedAt: null,
        ...(address === null ? {} : { publicIpv4: address }),
      },
    });
  }

  /** WPU-G18: detaches the server's own static IP; the instance then has an address of its own. */
  async function detachOwnStaticIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = client(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
    );
    if (found?.staticIp?.isAttached === true) {
      if (found.staticIp.attachedTo !== n.instance) throw fail("conflict");
      await lightsail.send(new DetachStaticIpCommand({ staticIpName: n.staticIp }));
    }
    // The address the tab shows follows the instance: unknown (null) until AWS has one.
    const live = await orNull(() =>
      lightsail.send(new GetInstanceCommand({ instanceName: n.instance })),
    );
    // WPU-M1: the time the IP stopped being attached, from which Amazon Lightsail's free hour counts.
    // A repeat of the operation keeps the first time; anything that is not an exact instant is replaced.
    const earlier = (ctx.resource.config as { detachedAt?: unknown } | null)?.detachedAt;
    const keep =
      found?.staticIp?.isAttached !== true &&
      typeof earlier === "string" &&
      !Number.isNaN(new Date(earlier).getTime()) &&
      new Date(earlier).toISOString() === earlier;
    return stepDone({
      configMerge: {
        staticIpAttached: false,
        detachedAt: keep ? earlier : ctx.clock.now().toISOString(),
        publicIpv4: ipOf(live?.instance?.publicIpAddress),
      },
    });
  }

  async function action(kind: OperationKind, ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const instanceName = names(ctx.resource.id).instance;
    const lightsail = client(ctx);
    switch (kind) {
      case "reboot":
        await lightsail.send(new RebootInstanceCommand({ instanceName }));
        return stepDone();
      case "stop":
        await lightsail.send(new StopInstanceCommand({ instanceName }));
        return stepDone({ state: "stopped" });
      case "start":
        await lightsail.send(new StartInstanceCommand({ instanceName }));
        return stepDone({ state: "active" });
      case "set_ports": {
        // The payload is written by the web tier: it is input (R9).
        const rules = parsePortRules((ctx.operation.payload as { ports?: unknown } | null)?.ports);
        if (rules === null) throw fail("validation");
        await lightsail.send(new PutInstancePublicPortsCommand({ instanceName, portInfos: rules }));
        // The list is saved on the resource: the Networking tab reads it (the web tier has no AWS).
        return stepDone({ configMerge: { firewallRules: rules } });
      }
      case "rename": {
        // The display name lives in our database only: AWS names are generated (R11). No AWS call.
        const name = parseServerDisplayName(
          (ctx.operation.payload as { displayName?: unknown } | null)?.displayName,
        );
        if (name === null) throw fail("validation");
        return stepDone({ configMerge: { displayName: name } });
      }
      case "attach_static_ip":
        return attachOwnStaticIp(ctx);
      case "detach_static_ip":
        return detachOwnStaticIp(ctx);
      default:
        // Anything else is not built yet: refuse (R16).
        throw fail("validation");
    }
  }

  return {
    family: "linux_instance",
    parseConfig(input: unknown): InstanceConfig {
      const parsed = parseInstanceConfig(input);
      if (!parsed.ok) throw fail("validation");
      return parsed.value;
    },
    aws: { create, suspend, resume, finalSnapshot, destroy, purgeSnapshots, describe, action },
  };
}
