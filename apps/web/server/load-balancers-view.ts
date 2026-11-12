import type { CustomerSession } from "@tc/auth";
import { priceCatalog } from "@tc/core";
import { customerRepos, listCatalogProducts, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary } from "@tc/db";

// What the load balancer screens show, read through the repositories of the session's customer (R8).
// A database error is thrown, never answered with an empty list (R16). Nothing here returns an AWS
// account id, an ARN, a generated AWS name or an error text of AWS (U6, R11): the resource config is
// read field by field. A target is a server of the customer: it is read through the same scoped
// repository, so a target id that is not the customer's shows as a removed one, never as a stranger's.

import { loadBalancerConsoleOf } from "./console-view.ts";
import type { LoadBalancerConsole } from "./console-view.ts";
const FLAG = "load_balancer";
const FAMILY = "load_balancer";
const INSTANCE_FAMILIES: readonly string[] = ["linux_instance", "windows_instance"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LoadBalancerFacts {
  name: string;
  targetIds: string[];
}

export function loadBalancerConfigOf(config: unknown): LoadBalancerFacts {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const targets = raw["targetIds"];
  return {
    name: typeof name === "string" ? name.slice(0, 60) : "",
    targetIds: Array.isArray(targets)
      ? targets.filter((t): t is string => typeof t === "string" && UUID.test(t)).slice(0, 20)
      : [],
  };
}

function nameOf(row: ResourceSummary): string {
  return loadBalancerConfigOf(row.config).name;
}

export interface LoadBalancerPlanOption {
  id: string;
  region: string;
  priceMinor: bigint;
}
export interface TargetServer {
  id: string;
  name: string;
  region: string | null;
}

export type LoadBalancerConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | { state: "ready"; plans: LoadBalancerPlanOption[]; servers: TargetServer[] };

/** The customer's own servers that can be a target: an instance, active (the rule of 10.3). */
function targetServersOf(resources: readonly ResourceSummary[]): TargetServer[] {
  return resources
    .filter((r) => INSTANCE_FAMILIES.includes(r.family) && r.state === "active")
    .map((r) => ({ id: r.id, name: nameOf(r), region: r.region }));
}

export async function loadLoadBalancerConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<LoadBalancerConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("load balancers: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const rows = await listCatalogProducts(tx, FAMILY);
    const priced = await priceCatalog(tx, rows, { market: profile.market }, { now });
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (!priced.ok) throw new Error("load balancers: the catalog could not be priced");
    const plans = priced.value.map((row) => ({
      id: row.id,
      region: row.region,
      priceMinor: row.priceBdt.totalMinor,
    }));
    return {
      state: "ready",
      plans,
      servers: targetServersOf(await repos.resources.list()),
    };
  });
}

export interface LoadBalancerRow {
  id: string;
  name: string;
  region: string | null;
  state: ResourceSummary["state"];
  targetCount: number;
}

export type LoadBalancerListScreen =
  { state: "flag_off" } | { state: "ready"; items: LoadBalancerRow[] };

export async function loadLoadBalancerList(
  session: CustomerSession,
): Promise<LoadBalancerListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("load balancers: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const resources = await repos.resources.list();
    const items = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r): LoadBalancerRow => {
        const facts = loadBalancerConfigOf(r.config);
        return {
          id: r.id,
          name: facts.name,
          region: r.region,
          state: r.state,
          targetCount: facts.targetIds.length,
        };
      });
    return { state: "ready", items };
  });
}

export interface LoadBalancerTarget {
  id: string;
  name: string;
  /** null: the server is gone (destroyed or not found for this customer). */
  state: ResourceSummary["state"] | null;
}

export interface LoadBalancerDetail extends LoadBalancerRow {
  /** Health check path, HTTPS redirect and certificate written by the adapter (WPU-G7). */
  console?: LoadBalancerConsole;
  createdAt: Date;
  targets: LoadBalancerTarget[];
  /** Servers of the customer in the same Region that are not a target yet. */
  candidates: { id: string; name: string }[];
}

export async function loadLoadBalancerDetail(
  session: CustomerSession,
  id: string,
): Promise<LoadBalancerDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    // R12, R16: with the flag off the page answers like a missing one.
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("load balancers: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return null;

    const facts = loadBalancerConfigOf(resource.config);
    const own = await repos.resources.list();
    const byId = new Map(own.map((r) => [r.id, r]));
    const targets = facts.targetIds.map((targetId): LoadBalancerTarget => {
      const row = byId.get(targetId);
      return row === undefined || !INSTANCE_FAMILIES.includes(row.family)
        ? { id: targetId, name: "", state: null }
        : { id: row.id, name: nameOf(row), state: row.state };
    });
    const attached = new Set(facts.targetIds);
    const candidates = targetServersOf(own)
      .filter((s) => !attached.has(s.id) && s.region === resource.region)
      .map((s) => ({ id: s.id, name: s.name }));
    return {
      id: resource.id,
      name: facts.name,
      region: resource.region,
      state: resource.state,
      targetCount: facts.targetIds.length,
      createdAt: resource.createdAt,
      console: loadBalancerConsoleOf(resource.config),
      targets,
      candidates,
    };
  });
}
