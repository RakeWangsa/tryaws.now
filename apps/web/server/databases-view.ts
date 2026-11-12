import type { CustomerSession } from "@tc/auth";
import { priceCatalog } from "@tc/core";
import { customerRepos, listCatalogProducts, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary } from "@tc/db";
import { planSpecsOf } from "./servers-view.ts";
import type { PlanSpecs } from "./servers-view.ts";

// What the database screens show, read through the repositories of the session's customer (R8). A
// database error is thrown, never answered with an empty list (R16). Nothing here returns an AWS
// account id, an ARN, a generated AWS name or an error text of AWS (U6, R11): the resource config is
// read field by field. The endpoint and the port are returned because the customer needs them to use
// the database (U6 exception), and only after they passed the checks below. The master password is
// never part of a view (U9): it comes through the reveal action only.

import { databaseConsoleOf } from "./console-view.ts";
import type { DatabaseConsole } from "./console-view.ts";
const FLAG = "database";
const FAMILY = "database";

export interface DatabaseSpecs extends PlanSpecs {
  /** "mysql" or "postgres": a plain word from the catalog, shown as text. */
  engine?: string;
  version?: string;
}

const ENGINE = /^[a-z][a-z0-9]{1,19}$/;
const VERSION = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;

/** The sizes, the engine and the version of a plan from the catalog specs; anything else is dropped. */
export function databaseSpecsOf(specs: unknown): DatabaseSpecs {
  const out: DatabaseSpecs = planSpecsOf(specs);
  if (typeof specs !== "object" || specs === null) return out;
  const raw = specs as Record<string, unknown>;
  if (typeof raw["engine"] === "string" && ENGINE.test(raw["engine"])) out.engine = raw["engine"];
  if (typeof raw["version"] === "string" && VERSION.test(raw["version"])) {
    out.version = raw["version"];
  }
  return out;
}

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL}){1,7}$`);

export interface DatabaseFacts {
  name: string;
  /** The address the customer connects to; null until the database has one. */
  endpoint: string | null;
  port: number | null;
}

export function databaseConfigOf(config: unknown): DatabaseFacts {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const address = raw["endpointAddress"];
  const port = raw["endpointPort"];
  return {
    name: typeof name === "string" ? name.slice(0, 60) : "",
    endpoint:
      typeof address === "string" && address.length <= 253 && HOST.test(address) ? address : null,
    port:
      typeof port === "number" && Number.isSafeInteger(port) && port >= 1 && port <= 65535
        ? port
        : null,
  };
}

export interface DatabasePlanOption {
  id: string;
  region: string;
  priceMinor: bigint;
  specs: DatabaseSpecs;
}

export type DatabaseConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | { state: "ready"; plans: DatabasePlanOption[]; regions: string[] };

export async function loadDatabaseConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<DatabaseConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("databases: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const rows = await listCatalogProducts(tx, FAMILY);
    const priced = await priceCatalog(tx, rows, { market: profile.market }, { now });
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (!priced.ok) throw new Error("databases: the catalog could not be priced");
    const plans: DatabasePlanOption[] = priced.value.map((row) => ({
      id: row.id,
      region: row.region,
      priceMinor: row.priceBdt.totalMinor,
      specs: databaseSpecsOf(row.specs),
    }));
    return { state: "ready", plans, regions: [...new Set(plans.map((plan) => plan.region))] };
  });
}

export interface DatabaseRow {
  id: string;
  name: string;
  region: string | null;
  state: ResourceSummary["state"];
  engine: string | null;
  version: string | null;
  endpoint: string | null;
  port: number | null;
  specs: DatabaseSpecs;
}

export type DatabaseListScreen = { state: "flag_off" } | { state: "ready"; items: DatabaseRow[] };

function rowOf(resource: ResourceSummary, specs: DatabaseSpecs): DatabaseRow {
  const facts = databaseConfigOf(resource.config);
  return {
    id: resource.id,
    name: facts.name,
    region: resource.region,
    state: resource.state,
    engine: specs.engine ?? null,
    version: specs.version ?? null,
    endpoint: facts.endpoint,
    port: facts.port,
    specs,
  };
}

export async function loadDatabaseList(session: CustomerSession): Promise<DatabaseListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("databases: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const [resources, catalog] = await Promise.all([
      repos.resources.list(),
      listCatalogProducts(tx, FAMILY),
    ]);
    const specsOf = new Map(catalog.map((row) => [row.id, databaseSpecsOf(row.specs)]));
    const items = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r) => rowOf(r, (r.productId !== null ? specsOf.get(r.productId) : undefined) ?? {}));
    return { state: "ready", items };
  });
}

export interface DatabaseBackup {
  id: string;
  name: string;
  sizeGb: number | null;
  createdAt: Date;
  state: string;
  /** The final snapshot of a destroy: it belongs to the lifecycle and is never deleted here. */
  final: boolean;
}

export interface DatabaseDetail extends DatabaseRow {
  /** Backup window and public mode written by the adapter (WPU-G7). */
  console?: DatabaseConsole;
  createdAt: Date;
  backups: DatabaseBackup[];
}

export async function loadDatabaseDetail(
  session: CustomerSession,
  id: string,
): Promise<DatabaseDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    // R12, R16: with the flag off the page answers like a missing one.
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("databases: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return null;
    const [children, catalog] = await Promise.all([
      repos.resources.listChildren(resource.id, "backup"),
      listCatalogProducts(tx, FAMILY),
    ]);
    const product = catalog.find((row) => row.id === resource.productId);
    const backups = children.map((b): DatabaseBackup => {
      const raw =
        typeof b.config === "object" && b.config !== null
          ? (b.config as Record<string, unknown>)
          : {};
      const size = raw["sizeGb"];
      return {
        id: b.id,
        name: typeof raw["displayName"] === "string" ? raw["displayName"].slice(0, 60) : "",
        sizeGb: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null,
        createdAt: b.createdAt,
        state: b.state,
        final: raw["final"] === true,
      };
    });
    return {
      console: databaseConsoleOf(resource.config),
      ...rowOf(resource, product === undefined ? {} : databaseSpecsOf(product.specs)),
      createdAt: resource.createdAt,
      backups,
    };
  });
}
