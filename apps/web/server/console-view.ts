import { checkCachePolicy } from "@tc/core";

// What the console forms (WPU-G7, WPU-G8) show from the config of a resource, read field by field. The
// adapter writes these fields through `configMerge`; the web tier shows them and never trusts their
// shape (R16): anything unexpected is left out. No AWS name, account id or raw AWS text passes here (U6).

function rec(config: unknown): Record<string, unknown> {
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export interface CertificateRecord {
  name: string;
  type: string;
  value: string;
}

export interface CertificateFacts {
  domain: string;
  /** A fixed set of upper-case words of the Lightsail certificate states, or "UNKNOWN". */
  status: string;
  attached: boolean;
  records: CertificateRecord[];
}

export interface LoadBalancerConsole {
  healthCheckPath: string | null;
  httpsRedirect: boolean | null;
  certificate: CertificateFacts | null;
}

const STATUSES = [
  "PENDING_VALIDATION",
  "ISSUED",
  "INACTIVE",
  "EXPIRED",
  "VALIDATION_TIMED_OUT",
  "REVOKED",
  "FAILED",
];

/** The certificate that an adapter saved in `config.certificate`, field by field; null if there is none. */
export function certificateFactsOf(cert: unknown): CertificateFacts | null {
  if (typeof cert !== "object" || cert === null || Array.isArray(cert)) return null;
  const c = cert as Record<string, unknown>;
  const records = Array.isArray(c["records"]) ? c["records"].slice(0, 8) : [];
  const status = str(c["status"], 40);
  return {
    domain: str(c["domain"], 253),
    status: STATUSES.includes(status) ? status : "UNKNOWN",
    attached: c["attached"] === true,
    records: records
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        name: str(r["name"], 300),
        type: str(r["type"], 16),
        value: str(r["value"], 300),
      })),
  };
}

export function loadBalancerConsoleOf(config: unknown): LoadBalancerConsole {
  const raw = rec(config);
  const path = raw["healthCheckPath"];
  const redirect = raw["httpsRedirect"];
  return {
    healthCheckPath: typeof path === "string" && path !== "" ? path.slice(0, 100) : null,
    httpsRedirect: typeof redirect === "boolean" ? redirect : null,
    certificate: certificateFactsOf(raw["certificate"]),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PlanFacts {
  /** The catalog product of the plan in force (the config's, else the resource row's). */
  currentProductId: string | null;
  /** The plan the customer chose for the next renewal, or null. */
  pendingProductId: string | null;
}

/** The plan in force and the pending plan of a container service or distribution (WPU-G8). */
export function planFactsOf(config: unknown, rowProductId: string | null): PlanFacts {
  const raw = rec(config);
  const read = (v: unknown): string | null => {
    const id = rec(v)["productId"];
    return typeof id === "string" && UUID.test(id) ? id : null;
  };
  const current = raw["productId"];
  return {
    currentProductId:
      typeof current === "string" && UUID.test(current) ? current : rowProductId,
    pendingProductId: read(raw["pendingPlan"]),
  };
}

export interface CachePolicyFacts {
  defaultBehavior: "cache" | "dont-cache";
  defaultTtl: number;
  minimumTtl: number;
  maximumTtl: number;
  allowedHttpMethods: string;
  cachedHttpMethods: string;
  cookies: "none" | "all";
  headers: "none" | "all";
  queryStrings: boolean;
  paths: { path: string; behavior: "cache" | "dont-cache" }[];
}

/** The cache policy the adapter saved, read again by the same rules; null when none or odd. */
export function cachePolicyFactsOf(config: unknown): CachePolicyFacts | null {
  const raw = rec(config)["cachePolicy"];
  if (raw === undefined) return null;
  const checked = checkCachePolicy(raw);
  if (!checked.ok) return null;
  const p = checked.value;
  return {
    defaultBehavior: p.defaultBehavior,
    defaultTtl: p.settings.defaultTtl,
    minimumTtl: p.settings.minimumTtl,
    maximumTtl: p.settings.maximumTtl,
    allowedHttpMethods: p.settings.allowedHttpMethods,
    cachedHttpMethods: p.settings.cachedHttpMethods,
    cookies: p.settings.cookies,
    headers: p.settings.headers,
    queryStrings: p.settings.queryStrings,
    paths: p.paths.map((x) => ({ path: x.path, behavior: x.behavior })),
  };
}

export interface DeploymentHistoryFacts {
  at: Date;
  images: string[];
  endpoint: boolean;
}

/** The deployment history the adapter saved (date, images, endpoint), newest first, at most ten. */
export function deploymentHistoryOf(config: unknown): DeploymentHistoryFacts[] {
  const list = rec(config)["deployments"];
  if (!Array.isArray(list)) return [];
  const out: DeploymentHistoryFacts[] = [];
  for (const entry of list.slice(-10)) {
    const e = rec(entry);
    const at = typeof e["at"] === "string" ? new Date(e["at"]) : null;
    if (at === null || Number.isNaN(at.getTime()) || !Array.isArray(e["images"])) continue;
    out.push({
      at,
      images: e["images"].filter((i): i is string => typeof i === "string").map((i) => i.slice(0, 255)).slice(0, 10),
      endpoint: e["endpoint"] === true,
    });
  }
  return out.reverse();
}

export interface DatabaseConsole {
  backupWindow: string | null;
  publiclyAccessible: boolean;
}

export function databaseConsoleOf(config: unknown): DatabaseConsole {
  const raw = rec(config);
  const window = raw["backupWindow"];
  return {
    backupWindow: typeof window === "string" && window !== "" ? window.slice(0, 11) : null,
    // The database is private until the customer opens it (10.4).
    publiclyAccessible: raw["publiclyAccessible"] === true,
  };
}

export function bucketVersioningOf(config: unknown): "Enabled" | "Suspended" | null {
  const v = rec(config)["versioning"];
  return v === "Enabled" || v === "Suspended" ? v : null;
}
