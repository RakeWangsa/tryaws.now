import type { CustomerSession } from "@tc/auth";
import { CDN_ORIGIN_FAMILIES, cdnBundleFrom, cdnDefaultDomain, priceCatalog } from "@tc/core";
import { customerRepos, listCatalogProducts, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary, Tx } from "@tc/db";
import {
  cachePolicyFactsOf,
  certificateFactsOf,
  planFactsOf,
  type CachePolicyFacts,
  type CertificateFacts,
} from "./console-view.ts";

// What the CDN screens show, read through the repositories of the session's customer (R8). A database
// error is thrown, never answered with an empty list (R16). Nothing here returns an AWS account id, an
// ARN, a generated AWS name or an error text of AWS (U6, R11): the resource config is read field by
// field. The default domain of a distribution is returned because the customer needs it (U6), and
// only after it passed cdnDefaultDomain.

const FLAG = "cdn";
const FAMILY = "cdn";

export type OriginKind = "server" | "loadBalancer" | "bucket";

const KIND_OF_FAMILY: Readonly<Record<string, OriginKind | undefined>> = {
  linux_instance: "server",
  windows_instance: "server",
  load_balancer: "loadBalancer",
  bucket: "bucket",
};

export type CdnCache = "cache" | "dont-cache";

export interface CdnFacts {
  name: string;
  originId: string | null;
  cacheBehavior: CdnCache;
  defaultDomain: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function cdnConfigOf(config: unknown): CdnFacts {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const origin = raw["originId"];
  return {
    name: typeof name === "string" ? name.slice(0, 60) : "",
    originId: typeof origin === "string" && UUID.test(origin) ? origin : null,
    cacheBehavior: raw["cacheBehavior"] === "dont-cache" ? "dont-cache" : "cache",
    defaultDomain: cdnDefaultDomain(raw["defaultDomain"]),
  };
}

function displayNameOf(row: ResourceSummary): string {
  const raw =
    typeof row.config === "object" && row.config !== null
      ? (row.config as Record<string, unknown>)
      : {};
  return typeof raw["displayName"] === "string" ? raw["displayName"].slice(0, 60) : "";
}

export interface OriginOption {
  id: string;
  kind: OriginKind;
  name: string;
}

export interface CdnPlanOption {
  id: string;
  region: string;
  bundle: "small_1_0" | "medium_1_0" | "large_1_0";
  priceMinor: bigint;
  transferGb?: number;
}

/**
 * The distribution bundles on sale, priced by the pricing engine (the amount is never computed here,
 * R4). null when no rate or rule is in force (R16).
 */
export async function loadCdnPlans(
  tx: Tx,
  market: string,
  now: () => Date,
): Promise<CdnPlanOption[] | null> {
  const rows = await listCatalogProducts(tx, FAMILY);
  const priced = await priceCatalog(tx, rows, { market }, { now });
  if (!priced.ok) return null;
  const awsIdOf = new Map(rows.map((row) => [row.id, row.awsId]));
  const plans: CdnPlanOption[] = [];
  for (const row of priced.value) {
    const bundle = cdnBundleFrom(awsIdOf.get(row.id));
    if (bundle === null) continue;
    const transfer =
      typeof row.specs === "object" && row.specs !== null
        ? (row.specs as Record<string, unknown>)["transferGb"]
        : undefined;
    plans.push({
      id: row.id,
      region: row.region,
      bundle,
      priceMinor: row.priceBdt.totalMinor,
      ...(typeof transfer === "number" && Number.isSafeInteger(transfer) && transfer >= 0
        ? { transferGb: transfer }
        : {}),
    });
  }
  return plans;
}

export type CdnConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | { state: "ready"; plans: CdnPlanOption[]; origins: OriginOption[] };

export async function loadCdnConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<CdnConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("cdn: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const plans = await loadCdnPlans(tx, profile.market, now);
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (plans === null) throw new Error("cdn: the catalog could not be priced");
    const resources = await repos.resources.list();
    const origins: OriginOption[] = [];
    for (const r of resources) {
      const kind = KIND_OF_FAMILY[r.family];
      if (kind === undefined || r.state !== "active" || !CDN_ORIGIN_FAMILIES.includes(r.family)) {
        continue;
      }
      origins.push({ id: r.id, kind, name: displayNameOf(r) });
    }
    return { state: "ready", plans, origins };
  });
}

export interface CdnRow {
  id: string;
  name: string;
  state: ResourceSummary["state"];
  originName: string | null;
  originKind: OriginKind | null;
  defaultDomain: string | null;
  cacheBehavior: CdnCache;
}

export type CdnListScreen = { state: "flag_off" } | { state: "ready"; items: CdnRow[] };

export async function loadCdnList(session: CustomerSession): Promise<CdnListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("cdn: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const resources = await repos.resources.list();
    const byId = new Map(resources.map((r) => [r.id, r]));
    const items = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r): CdnRow => {
        const facts = cdnConfigOf(r.config);
        const origin = facts.originId === null ? undefined : byId.get(facts.originId);
        return {
          id: r.id,
          name: facts.name,
          state: r.state,
          originName: origin === undefined ? null : displayNameOf(origin),
          originKind: origin === undefined ? null : (KIND_OF_FAMILY[origin.family] ?? null),
          defaultDomain: facts.defaultDomain,
          cacheBehavior: facts.cacheBehavior,
        };
      });
    return { state: "ready", items };
  });
}

export interface CdnDetail extends CdnRow {
  region: string | null;
  createdAt: Date;
  /** The cache policy the customer saved, or null while the defaults of the create are in force. */
  cachePolicy: CachePolicyFacts | null;
  /** The customer's own servers, load balancers and buckets that can be the origin (WPU-G8). */
  origins: OriginOption[];
  originId: string | null;
  certificate: CertificateFacts | null;
  currentProductId: string | null;
  pendingProductId: string | null;
  /** WPU-S3: the apply of the pending bundle failed; the plan tab says so. */
  pendingFailed: boolean;
  /** Bundles on sale in the Region of the distribution, priced by the engine; null if nothing can be priced. */
  plans: CdnPlanOption[] | null;
  /** The end of the paid term: a bundle change takes effect then. */
  renewsAt: Date | null;
}

export async function loadCdnDetail(
  session: CustomerSession,
  id: string,
): Promise<CdnDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    // R12, R16: with the flag off the page answers like a missing one.
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("cdn: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return null;
    const facts = cdnConfigOf(resource.config);
    const origin = facts.originId === null ? null : await repos.resources.get(facts.originId);
    const planFacts = planFactsOf(resource.config, resource.productId);
    const subscription = await repos.subscriptions.get(resource.id);
    const config =
      typeof resource.config === "object" && resource.config !== null
        ? (resource.config as Record<string, unknown>)
        : {};
    const all = await loadCdnPlans(tx, profile.market, () => new Date());
    const origins: OriginOption[] = [];
    for (const r of await repos.resources.list()) {
      const kind = KIND_OF_FAMILY[r.family];
      if (kind === undefined || r.state !== "active" || !CDN_ORIGIN_FAMILIES.includes(r.family)) {
        continue;
      }
      origins.push({ id: r.id, kind, name: displayNameOf(r) });
    }
    return {
      cachePolicy: cachePolicyFactsOf(config),
      origins,
      originId: facts.originId,
      certificate: certificateFactsOf(config["certificate"]),
      currentProductId: planFacts.currentProductId,
      pendingProductId: planFacts.pendingProductId,
      pendingFailed: planFacts.pendingFailed,
      plans: all === null ? null : all.filter((p) => p.region === config["region"]),
      renewsAt: subscription?.periodEnd ?? null,
      id: resource.id,
      name: facts.name,
      state: resource.state,
      originName: origin === null ? null : displayNameOf(origin),
      originKind: origin === null ? null : (KIND_OF_FAMILY[origin.family] ?? null),
      defaultDomain: facts.defaultDomain,
      cacheBehavior: facts.cacheBehavior,
      region: resource.region,
      createdAt: resource.createdAt,
    };
  });
}
