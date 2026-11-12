import type { CustomerSession } from "@tc/auth";
import { containerPlanFrom, decideDestructive, priceCatalog } from "@tc/core";
import {
  certificateFactsOf,
  deploymentHistoryOf,
  planFactsOf,
  type CertificateFacts,
  type DeploymentHistoryFacts,
} from "./console-view.ts";
import type { ContainerPower } from "@tc/core";
import {
  customerRepos,
  listCatalogProducts,
  readCatalogProduct,
  readFeatureFlag,
  withTx,
} from "@tc/db";
import type { CustomerOperation, ResourceSummary, Tx } from "@tc/db";

// What the container service screens show, read through the repositories of the session's customer
// (R8). A database error is thrown, never answered with an empty list (R16). The resource config is
// read field by field. Nothing here returns an AWS account id, an ARN, a generated AWS name or an
// error text of AWS (U6, R11). The public address of the service is the one exception (U6): it starts
// with the service name and the customer needs it, so it is shown, and only after it passed the host
// check below. The values of the environment are never returned (they may hold secrets, R14): only
// the names of the variables.

const FLAG = "container_service";
const FAMILY = "container_service";
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL}){1,7}$`);

export interface DeploymentFacts {
  containers: {
    image: string;
    ports: { port: number; protocol: string }[];
    variables: string[];
  }[];
  publicEndpoint: { port: number; healthCheckPath: string | null } | null;
}

export interface ContainerFacts {
  name: string;
  /** The public address, only when it is a plain host name (U6 exception). */
  publicUrl: string | null;
  deployment: DeploymentFacts | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The deployment that the adapter saved in `config.deployment`, field by field; null if it is odd. */
export function deploymentFactsOf(raw: unknown): DeploymentFacts | null {
  if (!isRecord(raw) || !isRecord(raw["containers"])) return null;
  const containers: DeploymentFacts["containers"] = [];
  for (const key of Object.keys(raw["containers"]).sort().slice(0, 10)) {
    const c = raw["containers"][key];
    if (!isRecord(c) || typeof c["image"] !== "string") return null;
    const ports: { port: number; protocol: string }[] = [];
    if (isRecord(c["ports"])) {
      for (const [port, protocol] of Object.entries(c["ports"]).slice(0, 20)) {
        if (/^\d{1,5}$/.test(port) && typeof protocol === "string") {
          ports.push({ port: Number(port), protocol: protocol.slice(0, 5) });
        }
      }
    }
    containers.push({
      image: c["image"].slice(0, 255),
      ports,
      variables: isRecord(c["environment"]) ? Object.keys(c["environment"]).slice(0, 50) : [],
    });
  }
  const ep = raw["publicEndpoint"];
  const publicEndpoint =
    isRecord(ep) && typeof ep["containerPort"] === "number"
      ? {
          port: ep["containerPort"],
          healthCheckPath:
            typeof ep["healthCheckPath"] === "string" ? ep["healthCheckPath"].slice(0, 200) : null,
        }
      : null;
  return { containers, publicEndpoint };
}

export function containerConfigOf(config: unknown): ContainerFacts {
  const raw = isRecord(config) ? config : {};
  const name = raw["displayName"];
  const url = raw["publicUrl"];
  return {
    name: typeof name === "string" ? name.slice(0, 60) : "",
    publicUrl: typeof url === "string" && url.length <= 253 && HOST.test(url) ? url : null,
    deployment: deploymentFactsOf(raw["deployment"]),
  };
}

export interface ContainerPlanOption {
  id: string;
  region: string;
  power: ContainerPower;
  scale: number;
  priceMinor: bigint;
  vcpus?: number;
  ramGb?: number;
}

/**
 * The container plans on sale, priced by the pricing engine (the amount is never computed here, R4).
 * null when no rate or rule is in force: nothing is priced and nothing is offered (R16).
 */
export async function loadContainerPlans(
  tx: Tx,
  market: string,
  now: () => Date,
): Promise<ContainerPlanOption[] | null> {
  const rows = await listCatalogProducts(tx, FAMILY);
  const priced = await priceCatalog(tx, rows, { market }, { now });
  if (!priced.ok) return null;
  const awsIdOf = new Map(rows.map((row) => [row.id, row.awsId]));
  const plans: ContainerPlanOption[] = [];
  for (const row of priced.value) {
    const plan = containerPlanFrom(awsIdOf.get(row.id), row.specs);
    if (plan === null) continue;
    const specs = isRecord(row.specs) ? row.specs : {};
    const vcpus = positive(specs["vcpus"]);
    const ramGb = positive(specs["ramGb"]);
    plans.push({
      id: row.id,
      region: row.region,
      power: plan.power,
      scale: plan.scale,
      priceMinor: row.priceBdt.totalMinor,
      ...(vcpus !== undefined ? { vcpus } : {}),
      ...(ramGb !== undefined ? { ramGb } : {}),
    });
  }
  return plans;
}

export type ContainerConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | { state: "ready"; plans: ContainerPlanOption[] };

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function loadContainerConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<ContainerConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("container: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const plans = await loadContainerPlans(tx, profile.market, now);
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (plans === null) throw new Error("container: the catalog could not be priced");
    return { state: "ready", plans };
  });
}

export interface ContainerRow {
  id: string;
  name: string;
  region: string | null;
  state: ResourceSummary["state"];
  publicUrl: string | null;
}

export type ContainerListScreen = { state: "flag_off" } | { state: "ready"; items: ContainerRow[] };

export async function loadContainerList(session: CustomerSession): Promise<ContainerListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("container: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const resources = await repos.resources.list();
    const items = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r): ContainerRow => {
        const facts = containerConfigOf(r.config);
        return {
          id: r.id,
          name: facts.name,
          region: r.region,
          state: r.state,
          publicUrl: facts.publicUrl,
        };
      });
    return { state: "ready", items };
  });
}

export interface DeploymentRun {
  id: string;
  state: string;
  needsApproval: boolean;
  createdAt: Date;
}

export interface ContainerDetail extends ContainerRow {
  power: ContainerPower | null;
  scale: number | null;
  deployment: DeploymentFacts | null;
  /** The newest deployment requests, state and date only (the payload is not readable here). */
  runs: DeploymentRun[];
  createdAt: Date;
  /** What the lifecycle guard says about a destroy of this family today (R13). */
  destroyOpen: boolean;
  /** The container (counted from 1) that serves the public endpoint, or null (WPU-G8). */
  endpointContainer: number | null;
  /** The plan in force and the one chosen for the next renewal (WPU-G8). */
  currentProductId: string | null;
  pendingProductId: string | null;
  /** WPU-S3: the apply of the pending plan failed; the plan tab says so. */
  pendingFailed: boolean;
  /** Plans on sale in the Region of the service, priced by the engine; null when nothing can be priced. */
  plans: ContainerPlanOption[] | null;
  /** The end of the paid term: a plan change takes effect then. */
  renewsAt: Date | null;
  certificate: CertificateFacts | null;
  history: DeploymentHistoryFacts[];
}

/** The container (from 1) that the saved public endpoint points at; null for none or anything odd. */
export function endpointContainerOf(deployment: unknown): number | null {
  if (!isRecord(deployment) || !isRecord(deployment["publicEndpoint"])) return null;
  const name = deployment["publicEndpoint"]["containerName"];
  const m = typeof name === "string" ? /^c([0-9]{1,2})$/.exec(name) : null;
  return m === null ? null : Number(m[1]);
}

export function runsOf(operations: readonly CustomerOperation[]): DeploymentRun[] {
  return operations
    .filter((op) => op.kind === "deploy_containers")
    .slice(0, 10)
    .map((op) => ({
      id: op.id,
      state: op.state,
      needsApproval: op.needsApproval,
      createdAt: op.createdAt,
    }));
}

export async function loadContainerDetail(
  session: CustomerSession,
  id: string,
): Promise<ContainerDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    // R12, R16: with the flag off the page answers like a missing one.
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("container: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return null;
    const facts = containerConfigOf(resource.config);
    const planFacts = planFactsOf(resource.config, resource.productId);
    const product =
      planFacts.currentProductId === null
        ? null
        : await readCatalogProduct(tx, planFacts.currentProductId);
    const plan = product === null ? null : containerPlanFrom(product.awsId, product.specs);
    const operations = await repos.operations.listForResource(resource.id);
    const subscription = await repos.subscriptions.get(resource.id);
    const region = isRecord(resource.config) ? resource.config["region"] : undefined;
    const all = await loadContainerPlans(tx, profile.market, () => new Date());
    return {
      id: resource.id,
      name: facts.name,
      region: resource.region,
      state: resource.state,
      publicUrl: facts.publicUrl,
      power: plan?.power ?? null,
      scale: plan?.scale ?? null,
      deployment: facts.deployment,
      runs: runsOf(operations),
      createdAt: resource.createdAt,
      destroyOpen: decideDestructive("destroy", {
        subscriptionStatus: "retained",
        family: FAMILY,
        hasFinalSnapshot: false,
        isFinalBackup: false,
      }),
      endpointContainer: endpointContainerOf(
        isRecord(resource.config) ? resource.config["deployment"] : null,
      ),
      currentProductId: planFacts.currentProductId,
      pendingProductId: planFacts.pendingProductId,
      pendingFailed: planFacts.pendingFailed,
      plans: all === null ? null : all.filter((p) => p.region === region),
      renewsAt: subscription?.periodEnd ?? null,
      certificate: certificateFactsOf(
        isRecord(resource.config) ? resource.config["certificate"] : null,
      ),
      history: deploymentHistoryOf(resource.config),
    };
  });
}
