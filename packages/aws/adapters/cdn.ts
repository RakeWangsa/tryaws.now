import {
  AttachCertificateToDistributionCommand,
  CreateDistributionCommand,
  DeleteDistributionCommand,
  DetachCertificateFromDistributionCommand,
  GetBucketsCommand,
  GetDistributionsCommand,
  GetInstanceCommand,
  GetLoadBalancerCommand,
  ResetDistributionCacheCommand,
  UpdateDistributionBundleCommand,
  UpdateDistributionCommand,
  type LightsailClient,
  type LightsailDistribution,
  type RegionName,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  cdnDefaultDomain,
  checkCachePolicy,
  checkCdnOrigin,
  checkedContainerCertificateDomain,
  parseCdnConfig,
  planFailedFor,
  resourceTags,
  stepDone,
  stepNext,
  stepWait,
  type AwsNameType,
  type CdnBundle,
  type CdnConfig,
  type CheckedOrigin,
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
import { LIGHTSAIL_REGIONS, type LightsailRegion } from "../roles";
import type { LiveState, OpCtx, ProductAdapter, ResourceView } from "./types";

/**
 * What the adapter needs and OpCtx does not carry: the bundle of a catalog product, read with the
 * customer id of the resource row (never a payload). null when the product is not a CDN product with
 * a known bundle: the call then fails closed (R16).
 */
export interface CdnDeps {
  loadBundle(input: {
    readonly customerId: string;
    readonly productId: string;
  }): Promise<CdnBundle | null>;
}

const POLL_SECONDS = 15;
const MAX_WAIT_MS = 30 * 60 * 1000;

// VERIFY in staging: the words of Distribution.status. These are the ones the docs and the console
// show; anything else fails closed.
const READY_STATUS = new Set(["deployed", "enabled", "active"]);
const BUSY_STATUS = new Set(["creating", "inprogress", "in-progress", "deploying", "updating"]);

type Ctx = OpCtx<CdnConfig>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE = ["active", "stopped", "suspended"];

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
const distributionName = (ctx: Ctx): string => awsResourceName("cdn", ctx.resource.id);
const certificateName = (ctx: Ctx): string => awsResourceName("cert", ctx.resource.id);
const pollAt = (ctx: Ctx): Date => new Date(ctx.clock.now().getTime() + POLL_SECONDS * 1000);

function budget(ctx: Ctx): void {
  if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
    throw fail("upstream_unavailable");
  }
}

async function findDistribution(
  lightsail: LightsailClient,
  name: string,
): Promise<LightsailDistribution | null> {
  const got = await orNull(() =>
    lightsail.send(new GetDistributionsCommand({ distributionName: name })),
  );
  return got?.distributions?.find((d) => d.name === name) ?? null;
}

interface OriginFacts {
  readonly name: string;
  readonly region: LightsailRegion;
  /** instance and load balancer are reached by http on port 80 (10.4); a bucket has no policy. */
  readonly protocolPolicy: "http-only" | undefined;
  readonly lookup: (lightsail: LightsailClient) => Promise<boolean>;
}

const NAME_TYPE: Readonly<Record<string, AwsNameType>> = {
  linux_instance: "instance",
  windows_instance: "instance",
  load_balancer: "lb",
  bucket: "bucket",
};

/**
 * The origin of the distribution (R8, R16). The id comes from the config, but it is resolved through
 * ctx.owned, which answers only for the customer of this operation, and judged by the pure rule: own,
 * an origin family, active. The AWS name is built only from that checked id. All customers of a pool
 * account share one account, so an origin that the account of the distribution does not know (another
 * pool account) is refused. Any failure is `validation` and nothing is created.
 */
async function checkedOrigin(ctx: Ctx, originId: string): Promise<OriginFacts> {
  // A value that is not a resource id never reaches the lookup (R11).
  if (!UUID.test(originId)) throw fail("validation");
  const row: ResourceView | null = await ctx.owned(originId);
  const checked = checkCdnOrigin({
    customerId: ctx.resource.customerId,
    requested: originId,
    candidate:
      row === null
        ? null
        : { id: row.id, customerId: row.customerId, family: row.family, state: row.state },
  });
  if (!checked.ok || row === null) throw fail("validation");
  const id: CheckedOrigin = checked.value;
  const region = (row.config as { region?: unknown } | null | undefined)?.region;
  if (typeof region !== "string" || !(LIGHTSAIL_REGIONS as readonly string[]).includes(region)) {
    throw fail("validation");
  }
  const type = NAME_TYPE[row.family];
  if (type === undefined) throw fail("validation");
  const name = awsResourceName(type, id);
  const lookup = async (lightsail: LightsailClient): Promise<boolean> => {
    switch (row.family) {
      case "load_balancer": {
        const got = await orNull(() =>
          lightsail.send(new GetLoadBalancerCommand({ loadBalancerName: name })),
        );
        return got?.loadBalancer !== undefined;
      }
      case "bucket": {
        const got = await orNull(() => lightsail.send(new GetBucketsCommand({ bucketName: name })));
        return (got?.buckets ?? []).length > 0;
      }
      default: {
        const got = await orNull(() =>
          lightsail.send(new GetInstanceCommand({ instanceName: name })),
        );
        // A distribution needs a server with a static IP as its origin (VERIFY in staging).
        return got?.instance?.isStaticIp === true;
      }
    }
  };
  return {
    name,
    region: region as LightsailRegion,
    protocolPolicy: row.family === "bucket" ? undefined : "http-only",
    lookup,
  };
}

export function createCdnAdapter(deps: CdnDeps): ProductAdapter<CdnConfig> {
  async function create(ctx: Ctx): Promise<StepResult> {
    const name = distributionName(ctx);
    const lightsail = client(ctx);
    switch (ctx.operation.step) {
      case null:
      case "create_distribution": {
        const bundle = await deps.loadBundle({
          customerId: ctx.resource.customerId,
          productId: ctx.config.productId,
        });
        if (bundle === null) throw fail("validation");
        const found = await findDistribution(lightsail, name);
        if (found !== null) {
          const ours = (found.tags ?? []).some(
            (t) => t.key === "tc:resource" && t.value === ctx.resource.id,
          );
          if (!ours) throw fail("conflict");
          return stepNext("wait_ready", { awsName: name });
        }
        const origin = await checkedOrigin(ctx, ctx.config.originId);
        const originClient = ctx.access.lightsail(ctx.account, origin.region, "TcProvisioner");
        if (!(await origin.lookup(originClient))) throw fail("validation");
        const orderId = (ctx.operation.payload as { orderId?: unknown } | null)?.orderId;
        await lightsail.send(
          new CreateDistributionCommand({
            distributionName: name,
            bundleId: bundle,
            origin: {
              name: origin.name,
              regionName: origin.region as RegionName,
              ...(origin.protocolPolicy !== undefined
                ? { protocolPolicy: origin.protocolPolicy }
                : {}),
            },
            defaultCacheBehavior: { behavior: ctx.config.cacheBehavior },
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
        const found = await findDistribution(lightsail, name);
        const status = (found?.status ?? "").toLowerCase();
        if (found !== null && READY_STATUS.has(status)) {
          const domain = cdnDefaultDomain(found.domainName);
          return stepDone({
            state: "active",
            awsName: name,
            ...(domain !== null ? { configMerge: { defaultDomain: domain } } : {}),
          });
        }
        if (found === null || BUSY_STATUS.has(status)) {
          budget(ctx);
          return stepWait("wait_ready", pollAt(ctx));
        }
        throw fail("upstream_unavailable");
      }
      default:
        throw fail("internal");
    }
  }

  async function setEnabled(ctx: Ctx, enabled: boolean): Promise<void> {
    await client(ctx).send(
      new UpdateDistributionCommand({
        distributionName: distributionName(ctx),
        isEnabled: enabled,
      }),
    );
  }

  // Suspend (10.3): the distribution is disabled; the settings stay in resources.config.
  async function suspend(ctx: Ctx): Promise<StepResult> {
    await setEnabled(ctx, false);
    return stepDone({ state: "suspended" });
  }

  async function resume(ctx: Ctx): Promise<StepResult> {
    await setEnabled(ctx, true);
    return stepDone({ state: "active" });
  }

  // No snapshot exists for a distribution: the settings in resources.config are what is kept (11).
  async function noSnapshot(): Promise<StepResult> {
    return stepDone();
  }

  async function destroy(ctx: Ctx): Promise<StepResult> {
    try {
      await client(ctx).send(
        new DeleteDistributionCommand({ distributionName: distributionName(ctx) }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return stepDone({ state: "destroyed" });
  }

  async function describe(ctx: Ctx): Promise<LiveState> {
    const found = await findDistribution(client(ctx), distributionName(ctx));
    return { state: found === null ? "missing" : (found.status ?? "unknown").toLowerCase() };
  }

  // setCdnEnabled (16.10): stop turns the distribution off, start turns it on again.
  /**
   * Takes the certificate off the distribution (Lightsail refuses to delete an attached one) and
   * deletes it. Every step is safe to repeat (R7). A distribution that cannot be read refuses (R16).
   */
  async function dropCertificate(ctx: Ctx): Promise<void> {
    const lightsail = client(ctx);
    const name = certificateName(ctx);
    const dist = await findDistribution(lightsail, distributionName(ctx));
    if (dist === null) throw fail("upstream_unavailable");
    if (dist.certificateName === name) {
      await lightsail.send(
        new DetachCertificateFromDistributionCommand({ distributionName: distributionName(ctx) }),
      );
    }
    await deleteCertificate(lightsail, name);
  }

  async function action(kind: OperationKind, ctx: Ctx): Promise<StepResult> {
    const payload = ctx.operation.payload as Record<string, unknown> | null;
    switch (kind) {
      case "stop":
        if (ctx.resource.state !== "active") throw fail("conflict");
        await setEnabled(ctx, false);
        return stepDone({ state: "stopped" });
      case "start":
        if (ctx.resource.state !== "stopped") throw fail("conflict");
        await setEnabled(ctx, true);
        return stepDone({ state: "active" });
      case "reset_cache":
        // Flushes the whole cache of this distribution; the name is generated (R11).
        if (ctx.resource.state !== "active") throw fail("conflict");
        await client(ctx).send(
          new ResetDistributionCacheCommand({ distributionName: distributionName(ctx) }),
        );
        return stepDone();
      case "schedule_plan_change": {
        // WPU-G8: no proration in a prepaid term. The choice is stored and the renewal applies it;
        // nothing is called in AWS. null cancels a pending change.
        if (!LIVE.includes(ctx.resource.state)) throw fail("conflict");
        const productId = payload?.productId;
        // WPU-S3: the failure mark of an earlier apply is never written here; the customer cannot
        // clear it. Only a successful apply removes it.
        if (productId === null) return stepDone({ configMerge: { pendingPlan: null } });
        if (typeof productId !== "string" || !UUID.test(productId)) throw fail("validation");
        if (productId === ctx.config.productId) throw fail("validation");
        if (planFailedFor(ctx.resource.config, productId)) throw fail("validation");
        const bundle = await deps.loadBundle({ customerId: ctx.resource.customerId, productId });
        if (bundle === null) throw fail("validation");
        return stepDone({ configMerge: { pendingPlan: { productId } } });
      }
      case "change_cdn_bundle": {
        // Queued by the renewal, never by a customer. The bundle comes from the catalog product the
        // renewal charged for, never from a name in the payload.
        const productId = payload?.productId;
        if (typeof productId !== "string" || !UUID.test(productId)) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        const bundle = await deps.loadBundle({ customerId: ctx.resource.customerId, productId });
        if (bundle === null) throw fail("validation");
        await client(ctx).send(
          new UpdateDistributionBundleCommand({
            distributionName: distributionName(ctx),
            bundleId: bundle,
          }),
        );
        return stepDone({
          configMerge: {
            productId,
            appliedPlan: { productId },
            pendingPlan: null,
            pendingPlanFailed: null,
          },
        });
      }
      case "set_cache_behaviors": {
        // The web tier wrote the payload: it is checked again by the one policy rule (R9, R16).
        const parsed = checkCachePolicy(payload);
        if (!parsed.ok) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        const policy = parsed.value;
        await client(ctx).send(
          new UpdateDistributionCommand({
            distributionName: distributionName(ctx),
            defaultCacheBehavior: { behavior: policy.defaultBehavior },
            cacheBehaviorSettings: {
              defaultTTL: policy.settings.defaultTtl,
              minimumTTL: policy.settings.minimumTtl,
              maximumTTL: policy.settings.maximumTtl,
              allowedHTTPMethods: policy.settings.allowedHttpMethods,
              cachedHTTPMethods: policy.settings.cachedHttpMethods,
              forwardedCookies: { option: policy.settings.cookies },
              forwardedHeaders: { option: policy.settings.headers },
              forwardedQueryStrings: { option: policy.settings.queryStrings },
            },
            cacheBehaviors: policy.paths.map((p) => ({ path: p.path, behavior: p.behavior })),
          }),
        );
        return stepDone({
          configMerge: { cachePolicy: policy, cacheBehavior: policy.defaultBehavior },
        });
      }
      case "set_cdn_origin": {
        if (ctx.resource.state !== "active") throw fail("conflict");
        const originId = payload?.originId;
        if (typeof originId !== "string") throw fail("validation");
        const origin = await checkedOrigin(ctx, originId);
        const originClient = ctx.access.lightsail(ctx.account, origin.region, "TcProvisioner");
        if (!(await origin.lookup(originClient))) throw fail("validation");
        await client(ctx).send(
          new UpdateDistributionCommand({
            distributionName: distributionName(ctx),
            origin: {
              name: origin.name,
              regionName: origin.region as RegionName,
              ...(origin.protocolPolicy !== undefined
                ? { protocolPolicy: origin.protocolPolicy }
                : {}),
            },
          }),
        );
        return stepDone({ configMerge: { originId } });
      }
      case "request_certificate": {
        const domain = checkedContainerCertificateDomain(payload?.domain);
        if (domain === null) throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        await ensureCertificate(client(ctx), {
          name: certificateName(ctx),
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
        const lightsail = client(ctx);
        const name = certificateName(ctx);
        const found = await readCertificate(lightsail, name);
        if (found === null) throw fail("validation");
        let attached = false;
        if (found.status === "ISSUED") {
          const dist = await findDistribution(lightsail, distributionName(ctx));
          if (dist === null) throw fail("upstream_unavailable");
          attached = dist.certificateName === name;
          if (!attached) {
            await lightsail.send(
              new AttachCertificateToDistributionCommand({
                distributionName: distributionName(ctx),
                certificateName: name,
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
        await requireCertificateGone(client(ctx), certificateName(ctx));
        await ensureCertificate(client(ctx), {
          name: certificateName(ctx),
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
    family: "cdn",
    parseConfig(input: unknown): CdnConfig {
      const parsed = parseCdnConfig(input);
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
