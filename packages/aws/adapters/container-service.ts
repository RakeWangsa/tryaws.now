import {
  CreateContainerServiceCommand,
  CreateContainerServiceDeploymentCommand,
  DeleteContainerServiceCommand,
  GetContainerServicesCommand,
  UpdateContainerServiceCommand,
  type ContainerService,
  type LightsailClient,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  checkedContainerCertificateDomain,
  deploymentHistoryEntry,
  parseContainerConfig,
  parseDeployment,
  planFailedFor,
  resourceTags,
  stepDone,
  stepNext,
  stepWait,
  type ContainerConfig,
  type ContainerPlan,
  type Deployment,
  type OperationKind,
  type StepResult,
} from "@tc/core";
import { AwsError } from "../errors";
import {
  certificateTags,
  deleteCertificate,
  ensureCertificate,
  readCertificate,
  requireCertificateGone,
} from "./certificate";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

/**
 * What the adapter needs and OpCtx does not carry: the power and scale of a catalog product, read
 * with the customer id of the resource row (never a payload). null when the product is not a
 * container product: the call then fails closed (R16).
 *
 * Public registry images only (10.3): the adapter has no way to hand out a registry credential and
 * never touches the private registry access of a service.
 */
export interface ContainerServiceDeps {
  loadPlan(input: {
    readonly customerId: string;
    readonly productId: string;
  }): Promise<ContainerPlan | null>;
}

const POLL_SECONDS = 15;
const MAX_WAIT_MS = 20 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(code: "validation" | "conflict" | "upstream_unavailable" | "internal"): AwsError {
  return new AwsError({ code, retryable: false });
}

function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "not_found";
}

async function orNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function client(ctx: OpCtx<ContainerConfig>): LightsailClient {
  return ctx.access.lightsail(ctx.account, ctx.region, "TcProvisioner");
}

function checkWaitBudget(ctx: OpCtx<ContainerConfig>): void {
  if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
    throw fail("upstream_unavailable");
  }
}

function pollAt(ctx: OpCtx<ContainerConfig>): Date {
  return new Date(ctx.clock.now().getTime() + POLL_SECONDS * 1000);
}

async function findService(
  lightsail: LightsailClient,
  name: string,
): Promise<ContainerService | null> {
  const got = await orNull(() =>
    lightsail.send(new GetContainerServicesCommand({ serviceName: name })),
  );
  return got?.containerServices?.find((s) => s.containerServiceName === name) ?? null;
}

function awsDeployment(serviceName: string, deployment: Deployment) {
  const endpoint = deployment.publicEndpoint;
  return {
    serviceName,
    containers: Object.fromEntries(
      Object.entries(deployment.containers).map(([name, c]) => [
        name,
        {
          image: c.image,
          ...(c.command ? { command: [...c.command] } : {}),
          ...(c.environment ? { environment: { ...c.environment } } : {}),
          ...(c.ports ? { ports: { ...c.ports } } : {}),
        },
      ]),
    ),
    ...(endpoint
      ? {
          publicEndpoint: {
            containerName: endpoint.containerName,
            containerPort: endpoint.containerPort,
            ...(endpoint.healthCheckPath
              ? { healthCheck: { path: endpoint.healthCheckPath } }
              : {}),
          },
        }
      : {}),
  };
}

function savedDeployment(ctx: OpCtx<ContainerConfig>): Deployment | null {
  const config = ctx.resource.config;
  if (typeof config !== "object" || config === null) return null;
  const raw = (config as Record<string, unknown>).deployment;
  if (raw === undefined || raw === null) return null;
  const parsed = parseDeployment(raw);
  // A saved deployment that does not hold any more is refused, not skipped (R16).
  if (!parsed.ok) throw fail("validation");
  return parsed.value;
}

export function createContainerServiceAdapter(
  deps: ContainerServiceDeps,
): ProductAdapter<ContainerConfig> {
  const serviceName = (ctx: OpCtx<ContainerConfig>) =>
    awsResourceName("container", ctx.resource.id);

  async function create(ctx: OpCtx<ContainerConfig>): Promise<StepResult> {
    const name = serviceName(ctx);
    const lightsail = client(ctx);
    switch (ctx.operation.step) {
      case null:
      case "create_service": {
        const plan = await deps.loadPlan({
          customerId: ctx.resource.customerId,
          productId: ctx.config.productId,
        });
        if (plan === null) throw fail("validation");
        const found = await findService(lightsail, name);
        if (found !== null) {
          const ours = (found.tags ?? []).some(
            (t) => t.key === "tc:resource" && t.value === ctx.resource.id,
          );
          if (!ours) throw fail("conflict");
          return stepNext("wait_ready", { awsName: name });
        }
        const orderId = (ctx.operation.payload as { orderId?: unknown } | null)?.orderId;
        await lightsail.send(
          new CreateContainerServiceCommand({
            serviceName: name,
            power: plan.power,
            scale: plan.scale,
            tags: resourceTags({
              env: ctx.env,
              customerId: ctx.resource.customerId,
              resourceId: ctx.resource.id,
              orderId: orderId as string,
            }),
          }),
        );
        return stepNext("wait_ready", { awsName: name });
      }
      case "wait_ready": {
        const state = (await findService(lightsail, name))?.state;
        if (state === "READY" || state === "RUNNING") return stepNext("deploy");
        if (state === "PENDING" || state === "UPDATING" || state === undefined) {
          checkWaitBudget(ctx);
          return stepWait("wait_ready", pollAt(ctx));
        }
        throw fail("upstream_unavailable");
      }
      case "deploy": {
        const deployment = savedDeployment(ctx);
        if (deployment === null) return stepDone({ state: "active", awsName: name });
        const service = await findService(lightsail, name);
        if (service === null) throw fail("upstream_unavailable");
        // A retry does not make a second deployment.
        if (service.currentDeployment !== undefined || service.nextDeployment !== undefined) {
          return stepNext("wait_deploy");
        }
        await lightsail.send(
          new CreateContainerServiceDeploymentCommand(awsDeployment(name, deployment)),
        );
        return stepNext("wait_deploy");
      }
      case "wait_deploy": {
        const state = (await findService(lightsail, name))?.state;
        if (state === "RUNNING") return stepDone({ state: "active", awsName: name });
        if (state === "DEPLOYING" || state === "UPDATING" || state === "PENDING") {
          checkWaitBudget(ctx);
          return stepWait("wait_deploy", pollAt(ctx));
        }
        throw fail("upstream_unavailable");
      }
      default:
        throw fail("internal");
    }
  }

  // Suspend (10.3): AWS still bills a disabled service. The settings stay in resources.config.
  async function suspend(ctx: OpCtx<ContainerConfig>): Promise<StepResult> {
    await client(ctx).send(
      new UpdateContainerServiceCommand({ serviceName: serviceName(ctx), isDisabled: true }),
    );
    return stepDone({ state: "suspended" });
  }

  async function resume(ctx: OpCtx<ContainerConfig>): Promise<StepResult> {
    await client(ctx).send(
      new UpdateContainerServiceCommand({ serviceName: serviceName(ctx), isDisabled: false }),
    );
    return stepDone({ state: "active" });
  }

  // No snapshot exists for a container service: the settings in resources.config are what is kept.
  async function noSnapshot(): Promise<StepResult> {
    return stepDone();
  }

  async function destroy(ctx: OpCtx<ContainerConfig>): Promise<StepResult> {
    if (ctx.resource.state !== "suspended") throw fail("conflict");
    try {
      await client(ctx).send(new DeleteContainerServiceCommand({ serviceName: serviceName(ctx) }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return stepDone({ state: "destroyed" });
  }

  async function describe(ctx: OpCtx<ContainerConfig>): Promise<LiveState> {
    const service = await findService(client(ctx), serviceName(ctx));
    return { state: service === null ? "missing" : (service.state ?? "unknown").toLowerCase() };
  }

  const LIVE = ["active", "stopped", "suspended"];

  // The last ten deployments the web tier asked for: date, images, whether there is an endpoint. The
  // environment values never leave the saved deployment (R14).
  function historyOf(ctx: OpCtx<ContainerConfig>, deployment: Deployment) {
    const raw = (ctx.resource.config as Record<string, unknown> | null)?.deployments;
    const before = Array.isArray(raw) ? raw.slice(-9) : [];
    return [...before, deploymentHistoryEntry(deployment, ctx.clock.now())];
  }

  /**
   * Takes the custom domain off the service (Lightsail keeps a certificate in use by a service) and
   * deletes the certificate. Other domain entries, if any, stay. Safe to repeat (R7); a service that
   * cannot be read refuses (R16).
   */
  async function dropCertificate(ctx: OpCtx<ContainerConfig>): Promise<void> {
    const lightsail = client(ctx);
    const name = serviceName(ctx);
    const certName = awsResourceName("cert", ctx.resource.id);
    const service = await findService(lightsail, name);
    if (service === null) throw fail("upstream_unavailable");
    const domains = service.publicDomainNames ?? {};
    if (Object.hasOwn(domains, certName)) {
      const rest = Object.fromEntries(Object.entries(domains).filter(([key]) => key !== certName));
      await lightsail.send(
        new UpdateContainerServiceCommand({ serviceName: name, publicDomainNames: rest }),
      );
    }
    await deleteCertificate(lightsail, certName);
  }

  async function action(kind: OperationKind, ctx: OpCtx<ContainerConfig>): Promise<StepResult> {
    const name = serviceName(ctx);
    const certName = awsResourceName("cert", ctx.resource.id);
    const lightsail = client(ctx);
    const payload = ctx.operation.payload as Record<string, unknown> | null;
    switch (kind) {
      case "deploy_containers": {
        // The payload is written by the web tier: it is input (R9).
        const parsed = parseDeployment(payload);
        if (!parsed.ok) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        await lightsail.send(
          new CreateContainerServiceDeploymentCommand(awsDeployment(name, parsed.value)),
        );
        return stepDone({
          configMerge: {
            deployment: parsed.value,
            deployments: historyOf(ctx, parsed.value),
          },
        });
      }
      case "clear_plan_change_mark":
        // WPA-P2: an admin cleared the failure mark of a plan change (audited in the admin app). Only
        // the config changes; nothing is called in AWS and nothing is charged or refunded.
        if (!LIVE.includes(ctx.resource.state)) throw fail("conflict");
        return stepDone({ configMerge: { pendingPlanFailed: null } });
      case "schedule_plan_change": {
        // WPU-G8: no proration in a prepaid term. The choice is stored and the scheduler applies it shortly before the renewal;
        // nothing is called in AWS and nothing is charged now. null cancels a pending change.
        if (!LIVE.includes(ctx.resource.state)) throw fail("conflict");
        const productId = payload?.productId;
        // WPU-S3: the failure mark of an earlier apply is never written here; the customer cannot
        // clear it. Only a successful apply removes it.
        if (productId === null) return stepDone({ configMerge: { pendingPlan: null } });
        if (typeof productId !== "string" || !UUID.test(productId)) throw fail("validation");
        if (productId === ctx.config.productId) throw fail("validation");
        if (planFailedFor(ctx.resource.config, productId)) throw fail("validation");
        const plan = await deps.loadPlan({ customerId: ctx.resource.customerId, productId });
        if (plan === null) throw fail("validation");
        return stepDone({ configMerge: { pendingPlan: { productId } } });
      }
      case "scale_container": {
        // Queued by the scheduler before the renewal (WPU-S5), never by a customer: the power and
        // scale come from the catalog product named in the payload, never from numbers in it.
        const productId = payload?.productId;
        if (typeof productId !== "string" || !UUID.test(productId)) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        const plan = await deps.loadPlan({ customerId: ctx.resource.customerId, productId });
        if (plan === null) throw fail("validation");
        await lightsail.send(
          new UpdateContainerServiceCommand({
            serviceName: name,
            power: plan.power,
            scale: plan.scale,
          }),
        );
        // The applied plan keeps pricing the later renewals (core lifecycle/plan-change).
        return stepDone({
          configMerge: {
            productId,
            appliedPlan: { productId },
            pendingPlan: null,
            pendingPlanFailed: null,
          },
        });
      }
      case "request_certificate": {
        const domain = checkedContainerCertificateDomain(payload?.domain);
        if (domain === null) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        await ensureCertificate(lightsail, {
          name: certName,
          domain,
          tags: certificateTags({
            env: ctx.env,
            customerId: ctx.resource.customerId,
            resourceId: ctx.resource.id,
          }),
        });
        return stepDone({
          configMerge: {
            certificate: { domain, status: "PENDING_VALIDATION", attached: false, records: [] },
          },
        });
      }
      case "refresh_certificate": {
        if (ctx.resource.state !== "active") throw fail("conflict");
        const found = await readCertificate(lightsail, certName);
        if (found === null) throw fail("validation");
        let attached = false;
        if (found.status === "ISSUED") {
          const service = await findService(lightsail, name);
          if (service === null) throw fail("upstream_unavailable");
          attached = Object.hasOwn(service.publicDomainNames ?? {}, certName);
          if (!attached) {
            await lightsail.send(
              new UpdateContainerServiceCommand({
                serviceName: name,
                publicDomainNames: { [certName]: [found.domain] },
              }),
            );
            attached = true;
          }
        }
        return stepDone({
          configMerge: {
            certificate: {
              domain: found.domain,
              status: found.status,
              attached,
              records: found.records,
            },
          },
        });
      }
      case "remove_certificate": {
        if (ctx.resource.state !== "active") throw fail("conflict");
        await dropCertificate(ctx);
        return stepDone({ configMerge: { certificate: null } });
      }
      case "replace_certificate": {
        // The new domain is checked before anything is touched (R11, R16).
        const domain = checkedContainerCertificateDomain(payload?.domain);
        if (domain === null) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        await dropCertificate(ctx);
        await requireCertificateGone(lightsail, certName);
        await ensureCertificate(lightsail, {
          name: certName,
          domain,
          tags: certificateTags({
            env: ctx.env,
            customerId: ctx.resource.customerId,
            resourceId: ctx.resource.id,
          }),
        });
        return stepDone({
          configMerge: {
            certificate: { domain, status: "PENDING_VALIDATION", attached: false, records: [] },
          },
        });
      }
      default:
        throw fail("validation");
    }
  }

  return {
    family: "container_service",
    parseConfig(input: unknown): ContainerConfig {
      const parsed = parseContainerConfig(input);
      if (!parsed.ok) throw fail("validation");
      return parsed.value;
    },
    aws: {
      create,
      suspend,
      resume,
      finalSnapshot: noSnapshot,
      destroy,
      purgeSnapshots: noSnapshot,
      describe,
      action,
    },
  };
}
