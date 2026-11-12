import {
  AttachInstancesToLoadBalancerCommand,
  AttachLoadBalancerTlsCertificateCommand,
  CreateLoadBalancerCommand,
  CreateLoadBalancerTlsCertificateCommand,
  DeleteLoadBalancerCommand,
  DetachInstancesFromLoadBalancerCommand,
  GetInstanceCommand,
  GetLoadBalancerCommand,
  GetLoadBalancerTlsCertificatesCommand,
  UpdateLoadBalancerAttributeCommand,
  type LightsailClient,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  checkLbTargets,
  checkedDomainName,
  checkedHealthPath,
  parseLoadBalancerConfig,
  resourceTags,
  stepDone,
  stepNext,
  stepWait,
  type LoadBalancerConfig,
  type OperationKind,
  type StepResult,
  type TargetCandidate,
} from "@tc/core";
import { AwsError } from "../errors";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

// Load balancers are created with instancePort 80, so 443 stays closed on the instances (10.4).
// HTTPS (CreateLoadBalancerTlsCertificate and AttachLoadBalancerTlsCertificate) uses the scarce
// certificate quota and is not built in this task. VERIFY in tc-pool-dev.
export const LB_INSTANCE_PORT = 80;

const POLL_SECONDS = 15;
const MAX_WAIT_MS = 20 * 60 * 1000;

type Ctx = OpCtx<LoadBalancerConfig>;

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

const client = (ctx: Ctx): LightsailClient =>
  ctx.access.lightsail(ctx.account, ctx.region, "TcProvisioner");
const lbName = (ctx: Ctx): string => awsResourceName("lb", ctx.resource.id);
const pollAt = (ctx: Ctx): Date => new Date(ctx.clock.now().getTime() + POLL_SECONDS * 1000);

function budget(ctx: Ctx): void {
  if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
    throw fail("upstream_unavailable");
  }
}

function savedTargets(ctx: Ctx): string[] | null {
  const config = ctx.resource.config;
  if (typeof config !== "object" || config === null) return null;
  const saved = (config as Record<string, unknown>).savedTargetIds;
  const checked = parseLoadBalancerConfig({
    productId: ctx.config.productId,
    region: ctx.config.region,
    displayName: ctx.config.displayName,
    targetIds: saved,
  });
  return checked.ok ? [...checked.value.targetIds] : null;
}

/**
 * The attach-time check (R8, R16). Every id is resolved through ctx.owned, which answers only for the
 * customer of this operation, then judged by the pure rule: own, an instance, active, this Region.
 * Then each target is looked up by its generated name in the pool account of the load balancer; an
 * instance AWS does not know there (another pool account) is refused. An AWS name is built only
 * from an id that passed. Any failure is `validation` and nothing is attached.
 */
async function checkedInstanceNames(ctx: Ctx, ids: readonly string[]): Promise<string[]> {
  const candidates: (TargetCandidate | null)[] = [];
  for (const id of ids) {
    const row = await ctx.owned(id);
    const region = (row?.config as { region?: unknown } | null | undefined)?.region;
    candidates.push(
      row === null
        ? null
        : {
            id: row.id,
            customerId: row.customerId,
            family: row.family,
            state: row.state,
            region: typeof region === "string" ? region : "",
          },
    );
  }
  const checked = checkLbTargets({
    customerId: ctx.resource.customerId,
    region: ctx.config.region,
    requested: ids,
    candidates,
  });
  if (!checked.ok) throw fail("validation");
  const lightsail = client(ctx);
  const out: string[] = [];
  for (const id of checked.value) {
    const name = awsResourceName("instance", id);
    const found = await orNull(() =>
      lightsail.send(new GetInstanceCommand({ instanceName: name })),
    );
    if (found?.instance === undefined) throw fail("validation");
    out.push(name);
  }
  return out;
}

async function attach(ctx: Ctx, ids: readonly string[], skipPresent: boolean): Promise<void> {
  const wanted = await checkedInstanceNames(ctx, ids);
  const lightsail = client(ctx);
  let missing = wanted;
  if (skipPresent) {
    const got = await lightsail.send(new GetLoadBalancerCommand({ loadBalancerName: lbName(ctx) }));
    const present = new Set(
      (got.loadBalancer?.instanceHealthSummary ?? []).map((s) => s.instanceName),
    );
    missing = wanted.filter((n) => !present.has(n));
  }
  if (missing.length === 0) return;
  await lightsail.send(
    new AttachInstancesToLoadBalancerCommand({
      loadBalancerName: lbName(ctx),
      instanceNames: missing,
    }),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function payloadOf(ctx: Ctx): Record<string, unknown> {
  const p = ctx.operation.payload;
  return typeof p === "object" && p !== null && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}

const certName = (ctx: Ctx): string => awsResourceName("lbcert", ctx.resource.id);

export function createLoadBalancerAdapter(): ProductAdapter<LoadBalancerConfig> {
  async function create(ctx: Ctx): Promise<StepResult> {
    const name = lbName(ctx);
    const lightsail = client(ctx);
    switch (ctx.operation.step) {
      case null:
      case "create_lb": {
        const found = await orNull(() =>
          lightsail.send(new GetLoadBalancerCommand({ loadBalancerName: name })),
        );
        if (found?.loadBalancer !== undefined) {
          const tags = found.loadBalancer.tags ?? [];
          if (!tags.some((t) => t.key === "tc:resource" && t.value === ctx.resource.id)) {
            throw fail("conflict");
          }
          return stepNext("wait_active", { awsName: name });
        }
        const orderId = (ctx.operation.payload as { orderId?: unknown } | null)?.orderId;
        await lightsail.send(
          new CreateLoadBalancerCommand({
            loadBalancerName: name,
            instancePort: LB_INSTANCE_PORT,
            tags: resourceTags({
              env: ctx.env,
              customerId: ctx.resource.customerId,
              resourceId: ctx.resource.id,
              orderId: orderId as string,
            }),
          }),
        );
        return stepNext("wait_active", { awsName: name });
      }
      case "wait_active": {
        const got = await lightsail.send(new GetLoadBalancerCommand({ loadBalancerName: name }));
        const state = got.loadBalancer?.state;
        if (state === "active") return stepNext("attach_targets");
        if (state === "provisioning" || state === "active_impaired" || state === undefined) {
          budget(ctx);
          return stepWait("wait_active", pollAt(ctx));
        }
        throw fail("upstream_unavailable");
      }
      case "attach_targets":
        await attach(ctx, ctx.config.targetIds, true);
        return stepDone({ state: "active", awsName: name });
      default:
        throw fail("internal");
    }
  }

  // Suspend detaches every target and remembers the list in the config; resume checks the list
  // again and attaches what still passes the rule.
  async function suspend(ctx: Ctx): Promise<StepResult> {
    const ids = ctx.config.targetIds;
    if (ids.length > 0) {
      try {
        await client(ctx).send(
          new DetachInstancesFromLoadBalancerCommand({
            loadBalancerName: lbName(ctx),
            instanceNames: ids.map((id) => awsResourceName("instance", id)),
          }),
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return stepDone({ state: "suspended", configMerge: { savedTargetIds: [...ids] } });
  }

  async function resume(ctx: Ctx): Promise<StepResult> {
    const ids = savedTargets(ctx);
    if (ids === null) throw fail("validation");
    await attach(ctx, ids, false);
    return stepDone({ state: "active" });
  }

  async function destroy(ctx: Ctx): Promise<StepResult> {
    try {
      await client(ctx).send(new DeleteLoadBalancerCommand({ loadBalancerName: lbName(ctx) }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return stepDone({ state: "destroyed" });
  }

  async function describe(ctx: Ctx): Promise<LiveState> {
    const got = await orNull(() =>
      client(ctx).send(new GetLoadBalancerCommand({ loadBalancerName: lbName(ctx) })),
    );
    return { state: got?.loadBalancer?.state ?? "missing" };
  }

  // The console actions (WPU-G7). The payload is written by the web tier, so it is input (R9, R16).
  async function action(kind: OperationKind, ctx: Ctx): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const lightsail = client(ctx);
    switch (kind) {
      case "set_targets": {
        const ids = payload.targetIds;
        if (
          !Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 64 ||
          !ids.every((id) => typeof id === "string" && UUID.test(id))
        ) {
          throw fail("validation");
        }
        if (ctx.resource.state !== "active") throw fail("conflict");
        const wanted = await checkedInstanceNames(ctx, ids as string[]);
        const got = await lightsail.send(
          new GetLoadBalancerCommand({ loadBalancerName: lbName(ctx) }),
        );
        const present = new Set(
          (got.loadBalancer?.instanceHealthSummary ?? []).map((x) => x.instanceName ?? ""),
        );
        const toAttach = wanted.filter((n) => !present.has(n));
        const toDetach = [...present].filter((n) => n !== "" && !wanted.includes(n));
        if (toAttach.length > 0) {
          await lightsail.send(
            new AttachInstancesToLoadBalancerCommand({
              loadBalancerName: lbName(ctx),
              instanceNames: toAttach,
            }),
          );
        }
        if (toDetach.length > 0) {
          await lightsail.send(
            new DetachInstancesFromLoadBalancerCommand({
              loadBalancerName: lbName(ctx),
              instanceNames: toDetach,
            }),
          );
        }
        return stepDone({ configMerge: { targetIds: [...(ids as string[])] } });
      }
      case "set_lb_attributes": {
        const path = payload.healthCheckPath;
        const redirect = payload.httpsRedirect;
        if (path === undefined && redirect === undefined) throw fail("validation");
        if (path !== undefined && checkedHealthPath(path) === null) {
          throw fail("validation");
        }
        if (redirect !== undefined && typeof redirect !== "boolean") throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        const merge: Record<string, unknown> = {};
        if (path !== undefined) {
          await lightsail.send(
            new UpdateLoadBalancerAttributeCommand({
              loadBalancerName: lbName(ctx),
              attributeName: "HealthCheckPath",
              attributeValue: path as string,
            }),
          );
          merge.healthCheckPath = path;
        }
        if (redirect !== undefined) {
          await lightsail.send(
            new UpdateLoadBalancerAttributeCommand({
              loadBalancerName: lbName(ctx),
              attributeName: "HttpsRedirectionEnabled",
              attributeValue: String(redirect),
            }),
          );
          merge.httpsRedirect = redirect;
        }
        return stepDone({ configMerge: merge });
      }
      case "request_certificate": {
        const domain = checkedDomainName(payload.domain);
        if (domain === null) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        const listed = await lightsail.send(
          new GetLoadBalancerTlsCertificatesCommand({ loadBalancerName: lbName(ctx) }),
        );
        const exists = (listed.tlsCertificates ?? []).some((c) => c.name === certName(ctx));
        if (!exists) {
          await lightsail.send(
            new CreateLoadBalancerTlsCertificateCommand({
              loadBalancerName: lbName(ctx),
              certificateName: certName(ctx),
              certificateDomainName: domain,
            }),
          );
        }
        return stepDone({
          configMerge: {
            certificate: { domain, status: "PENDING_VALIDATION", attached: false, records: [] },
          },
        });
      }
      case "refresh_certificate": {
        if (ctx.resource.state !== "active") throw fail("conflict");
        const listed = await lightsail.send(
          new GetLoadBalancerTlsCertificatesCommand({ loadBalancerName: lbName(ctx) }),
        );
        const found = (listed.tlsCertificates ?? []).find((c) => c.name === certName(ctx));
        if (found === undefined) throw fail("validation");
        const status = found.status ?? "UNKNOWN";
        let attached = found.isAttached === true;
        if (status === "ISSUED" && !attached) {
          await lightsail.send(
            new AttachLoadBalancerTlsCertificateCommand({
              loadBalancerName: lbName(ctx),
              certificateName: certName(ctx),
            }),
          );
          attached = true;
        }
        const records = (found.domainValidationRecords ?? []).slice(0, 8).map((r) => ({
          name: r.name ?? "",
          type: r.type ?? "",
          value: r.value ?? "",
        }));
        return stepDone({
          configMerge: {
            certificate: { domain: found.domainName ?? "", status, attached, records },
          },
        });
      }
      default:
        throw fail("validation");
    }
  }

  return {
    family: "load_balancer",
    parseConfig(input: unknown): LoadBalancerConfig {
      const parsed = parseLoadBalancerConfig(input);
      if (!parsed.ok) throw fail("validation");
      return parsed.value;
    },
    aws: {
      create,
      suspend,
      resume,
      // A load balancer has no snapshot: its settings are kept in resources.config (11).
      finalSnapshot: async () => stepDone(),
      destroy,
      purgeSnapshots: async () => stepDone(),
      describe,
      action,
    },
  };
}
