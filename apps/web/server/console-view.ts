// What the console forms (WPU-G7) show from the config of a resource, read field by field. The
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

export function loadBalancerConsoleOf(config: unknown): LoadBalancerConsole {
  const raw = rec(config);
  const path = raw["healthCheckPath"];
  const redirect = raw["httpsRedirect"];
  const cert = raw["certificate"];
  let certificate: CertificateFacts | null = null;
  if (typeof cert === "object" && cert !== null) {
    const c = cert as Record<string, unknown>;
    const records = Array.isArray(c["records"]) ? c["records"].slice(0, 8) : [];
    const status = str(c["status"], 40);
    certificate = {
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
  return {
    healthCheckPath: typeof path === "string" && path !== "" ? path.slice(0, 100) : null,
    httpsRedirect: typeof redirect === "boolean" ? redirect : null,
    certificate,
  };
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
