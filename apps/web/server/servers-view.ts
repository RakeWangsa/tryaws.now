import type { CustomerSession } from "@tc/auth";
import { priceCatalog } from "@tc/core";
import type { SshKey } from "@tc/db";
import {
  customerRepos,
  listCatalogProducts,
  readCatalogProduct,
  readFeatureFlag,
  withTx,
} from "@tc/db";
import type { ResourceSummary } from "@tc/db";

// What the server screens show, read through the repositories of the session's customer (R8). A
// database error is thrown, never answered with an empty list (R16). Nothing here returns an AWS
// account id, an ARN, a generated AWS name or an error text of AWS (U6, R11): the resource config is
// read field by field.

const FLAG = "linux_instance";
const FAMILY = "linux_instance";

export interface PlanSpecs {
  vcpus?: number;
  ramGb?: string;
  diskGb?: number;
  transferGb?: number;
}

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The sizes of a plan from the catalog specs; a value that is not a plain size is dropped. */
export function planSpecsOf(specs: unknown): PlanSpecs {
  const out: PlanSpecs = {};
  if (typeof specs !== "object" || specs === null) return out;
  const raw = specs as Record<string, unknown>;
  if (isCount(raw["vcpus"]) && raw["vcpus"] > 0) out.vcpus = raw["vcpus"];
  if (typeof raw["ramGb"] === "string" && /^\d{1,4}(\.\d{1,2})?$/.test(raw["ramGb"])) {
    out.ramGb = raw["ramGb"];
  }
  if (isCount(raw["diskGb"])) out.diskGb = raw["diskGb"];
  if (isCount(raw["transferGb"])) out.transferGb = raw["transferGb"];
  return out;
}

export interface ServerConfig {
  displayName: string;
  keyPairId: string | null;
  publicIp: string | null;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function serverConfigOf(config: unknown): ServerConfig {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const key = raw["keyPairId"];
  const ip = raw["publicIpv4"];
  return {
    displayName: typeof name === "string" ? name.slice(0, 60) : "",
    keyPairId: typeof key === "string" && key !== "" ? key : null,
    publicIp: typeof ip === "string" && IPV4.test(ip) ? ip : null,
  };
}

export type OrderProgress = "paid" | "creating" | "ready" | "delayed" | "failed";

/** 16.11 step 6: the state of the create operation, as words for the customer. */
export function orderProgress(operationState: string | null): OrderProgress {
  switch (operationState) {
    case null:
      return "paid";
    case "queued":
    case "running":
    case "waiting":
      return "creating";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
    default:
      // needs_attention, needs_approval and any state this screen does not know: "delayed".
      return "delayed";
  }
}

/** 16.11 step 4: the shortfall rounded up to whole taka (integers only, R4); null when covered. */
export function shortfallTopUpTaka(totalMinor: bigint, balanceMinor: bigint): bigint | null {
  if (balanceMinor >= totalMinor) return null;
  return (totalMinor - balanceMinor + 99n) / 100n;
}

export interface PlanOption {
  id: string;
  region: string;
  priceMinor: bigint;
  specs: PlanSpecs;
}
export interface KeyOption {
  id: string;
  name: string;
  fingerprint: string;
}

export type ConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | { state: "ready"; plans: PlanOption[]; regions: string[]; keys: KeyOption[] };

export async function loadConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<ConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("servers: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const rows = (await listCatalogProducts(tx, FAMILY)).filter((r) => r.platform === "linux");
    const priced = await priceCatalog(tx, rows, { market: profile.market }, { now });
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (!priced.ok) throw new Error("servers: the catalog could not be priced");
    const plans: PlanOption[] = priced.value.map((row) => ({
      id: row.id,
      region: row.region,
      priceMinor: row.priceBdt.totalMinor,
      specs: planSpecsOf(row.specs),
    }));
    const keys = await repos.sshKeys.list();
    return {
      state: "ready",
      plans,
      regions: [...new Set(plans.map((plan) => plan.region))],
      keys: keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })),
    };
  });
}

export interface ServerRow {
  id: string;
  name: string;
  region: string | null;
  state: ResourceSummary["state"];
  publicIp: string | null;
  specs: PlanSpecs;
}

export type ServersScreen = { state: "flag_off" } | { state: "ready"; servers: ServerRow[] };

export async function loadServers(session: CustomerSession): Promise<ServersScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("servers: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const [resources, catalog] = await Promise.all([
      repos.resources.list(),
      listCatalogProducts(tx, FAMILY),
    ]);
    const specsOf = new Map(catalog.map((row) => [row.id, planSpecsOf(row.specs)]));
    const servers = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r): ServerRow => {
        const config = serverConfigOf(r.config);
        return {
          id: r.id,
          name: config.displayName,
          region: r.region,
          state: r.state,
          publicIp: config.publicIp,
          specs: (r.productId !== null ? specsOf.get(r.productId) : undefined) ?? {},
        };
      });
    return { state: "ready", servers };
  });
}

export interface ServerDetail extends ServerRow {
  keyName: string | null;
  createdAt: Date;
}

export async function loadServerDetail(
  session: CustomerSession,
  id: string,
): Promise<ServerDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    const config = serverConfigOf(resource.config);
    const [product, key] = await Promise.all([
      resource.productId !== null ? readCatalogProduct(tx, resource.productId) : null,
      config.keyPairId !== null ? repos.sshKeys.get(config.keyPairId) : null,
    ]);
    return {
      id: resource.id,
      name: config.displayName,
      region: resource.region,
      state: resource.state,
      publicIp: config.publicIp,
      specs: product === null ? {} : planSpecsOf(product.specs),
      keyName: key?.name ?? null,
      createdAt: resource.createdAt,
    };
  });
}

export interface OrderScreen {
  id: string;
  totalMinor: bigint;
  createdAt: Date;
  progress: OrderProgress;
  resourceId: string | null;
  serverName: string;
}

export async function loadOrder(session: CustomerSession, id: string): Promise<OrderScreen | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const order = await repos.orders.get(id);
    if (order === null) return null;
    const first = Array.isArray(order.items) ? (order.items[0] as unknown) : undefined;
    const resourceId =
      typeof first === "object" &&
      first !== null &&
      typeof (first as { resourceId?: unknown }).resourceId === "string"
        ? (first as { resourceId: string }).resourceId
        : null;
    const resource = resourceId === null ? null : await repos.resources.get(resourceId);
    const operations = resource === null ? [] : await repos.operations.listForResource(resource.id);
    const create = operations.filter((op) => op.kind === "create").at(-1) ?? null;
    return {
      id: order.id,
      totalMinor: order.totalMinor,
      createdAt: order.createdAt,
      progress: orderProgress(create?.state ?? null),
      resourceId: resource?.id ?? null,
      serverName: resource === null ? "" : serverConfigOf(resource.config).displayName,
    };
  });
}

export async function loadSshKeys(session: CustomerSession): Promise<SshKey[]> {
  return withTx((tx) => customerRepos(tx, session.customerId).sshKeys.list());
}
