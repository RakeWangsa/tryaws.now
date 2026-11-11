import {
  CreateInstancesCommand,
  GetInstanceCommand,
  GetStaticIpCommand,
  AllocateStaticIpCommand,
  AttachStaticIpCommand,
  PutInstancePublicPortsCommand,
  type PortInfo,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  resourceTags,
  stepDone,
  stepNext,
  stepWait,
  type InstanceConfig,
  type StepResult,
} from "@tc/core";
import { windowsBootstrapScript } from "./bootstrap-windows";
import { createLinuxInstanceAdapter, type LinuxInstanceDeps } from "./linux-instance";
import { checkWaitBudget, fail, hasTag, lightsailOf, orNull, pollAt } from "./shared";
import type { OpCtx, ProductAdapter } from "./types";

/**
 * What the adapter needs and OpCtx (contract F) does not carry, like `LinuxInstanceDeps` but with no
 * customer key: a Windows instance uses the pool's default key pair (10.3), so the customer's key
 * is never read. `loadLaunch` returns null when the product is not a Windows bundle of the catalog:
 * the create then fails closed (R16).
 */
export interface WindowsLaunchSpec {
  readonly bundleId: string;
  readonly blueprintId: string;
}
export interface WindowsInstanceDeps {
  loadLaunch(input: {
    readonly customerId: string;
    readonly productId: string;
  }): Promise<WindowsLaunchSpec | null>;
  /** The verified VPC CIDR of the pool account and Region; null (unknown) blocks every RFC 1918 source. */
  vpcCidr(input: { readonly region: string }): Promise<string | null>;
  /** Has the bootstrap printed its marker? Without it the instance is never handed over (R16). VERIFY how it is read. */
  bootstrapMarker: LinuxInstanceDeps["bootstrapMarker"];
}

// RDP only, IPv4 only until the IPv6 cases of tests/isolation hold (10.4).
const RDP_PORTS: readonly PortInfo[] = Object.freeze([
  { fromPort: 3389, toPort: 3389, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
]);

function names(resourceId: string) {
  return {
    instance: awsResourceName("instance", resourceId),
    staticIp: awsResourceName("staticip", resourceId),
  };
}

/**
 * The Windows instance adapter. Only `create` differs from a Linux instance: no key import, the
 * default key pair, a PowerShell bootstrap, `tc:os` = `windows`, RDP as the default port and no
 * automatic snapshot add-on (Lightsail does not support it on Windows; backups are manual). Suspend,
 * resume, snapshot, destroy, describe and the actions work on generated names and open ports only,
 * so they are the Linux ones, unchanged.
 */
export function createWindowsInstanceAdapter(
  deps: WindowsInstanceDeps,
): ProductAdapter<InstanceConfig> {
  // `create` of the Linux adapter is replaced below, so its own deps are never called.
  const shared = createLinuxInstanceAdapter({
    loadLaunch: async () => null,
    vpcCidr: deps.vpcCidr,
    bootstrapMarker: deps.bootstrapMarker,
  });

  async function createInstance(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const spec = await deps.loadLaunch({
      customerId: ctx.resource.customerId,
      productId: ctx.config.productId,
    });
    if (spec === null) throw fail("validation");
    const n = names(ctx.resource.id);
    const lightsail = lightsailOf(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetInstanceCommand({ instanceName: n.instance })),
    );
    if (found?.instance !== undefined) {
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
        // No keyPairName: Lightsail uses the Region's default key pair, which is what
        // GetInstanceAccessDetails decrypts the password with.
        userData: windowsBootstrapScript({ vpcCidr: await deps.vpcCidr({ region: ctx.region }) }),
        ipAddressType: "ipv4",
        tags: resourceTags({
          env: ctx.env,
          customerId: ctx.resource.customerId,
          resourceId: ctx.resource.id,
          orderId: orderId as string,
          os: "windows",
        }),
      }),
    );
    return stepNext("wait_running", { awsName: n.instance });
  }

  async function waitRunning(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const got = await lightsailOf(ctx).send(
      new GetInstanceCommand({ instanceName: names(ctx.resource.id).instance }),
    );
    const state = got.instance?.state?.name;
    if (state === "running") return stepNext("verify_bootstrap");
    if (state === "pending" || state === undefined) {
      checkWaitBudget(ctx);
      return stepWait("wait_running", pollAt(ctx));
    }
    throw fail("upstream_unavailable");
  }

  async function verifyBootstrap(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const seen = await deps.bootstrapMarker({
      instanceName: names(ctx.resource.id).instance,
      region: ctx.region,
    });
    if (seen === "present") return stepNext("allocate_ip");
    if (seen === "pending") {
      checkWaitBudget(ctx);
      return stepWait("verify_bootstrap", pollAt(ctx));
    }
    throw fail("upstream_unavailable");
  }

  async function allocateIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = lightsailOf(ctx);
    const found = await orNull(() =>
      lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp })),
    );
    if (found === null)
      await lightsail.send(new AllocateStaticIpCommand({ staticIpName: n.staticIp }));
    return stepNext("attach_ip");
  }

  async function attachIp(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    const lightsail = lightsailOf(ctx);
    const got = await lightsail.send(new GetStaticIpCommand({ staticIpName: n.staticIp }));
    if (got.staticIp?.isAttached === true) {
      if (got.staticIp.attachedTo !== n.instance) throw fail("conflict");
    } else {
      await lightsail.send(
        new AttachStaticIpCommand({ staticIpName: n.staticIp, instanceName: n.instance }),
      );
    }
    return stepNext("open_ports");
  }

  async function openPorts(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    const n = names(ctx.resource.id);
    await lightsailOf(ctx).send(
      new PutInstancePublicPortsCommand({ instanceName: n.instance, portInfos: [...RDP_PORTS] }),
    );
    return stepDone({ state: "active", awsName: n.instance });
  }

  async function create(ctx: OpCtx<InstanceConfig>): Promise<StepResult> {
    switch (ctx.operation.step) {
      case null:
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

  return {
    family: "windows_instance",
    parseConfig: shared.parseConfig,
    aws: { ...shared.aws, create },
  };
}
