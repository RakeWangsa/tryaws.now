import type { CustomerSession } from "@tc/auth";
import {
  MAX_ACCESS_INSTANCES,
  cdnBundleFrom,
  checkCdnOrigin,
  checkedBackupWindow,
  checkedContainerCertificateDomain,
  checkedDomainName,
  checkedHealthPath,
  checkedDbParameterChanges,
  checkedMaintenanceWindow,
  containerPlanFrom,
  DB_PARAMETER_RULES,
  dbEngineFrom,
  parseCachePolicy,
  planApplyInFlight,
  planFailedFor,
  withPublicEndpoint,
} from "@tc/core";
import type { OperationKind } from "@tc/core";
import type { ResourceSummary } from "@tc/db";
import { certificateFactsOf } from "./console-view.ts";
import {
  FAMILY_WRITE_LIMIT,
  Refusal,
  UUID,
  audit,
  frame,
  ownResource,
  parseOf,
  record,
  uuidField,
} from "./family-actions.ts";
import type { FamilyActionDeps, FamilyRepos, FamilyResult } from "./family-actions.ts";

// The cores of the console actions of the customer panel (WPU-G7): load balancer settings and
// certificate, database backup window and public mode, bucket versioning, CDN cache flush. One generic
// core, one spec each. R9 order in every action: authenticate, authorize (the flag and the ownership of
// the resource), validate, rate limit, execute (an operation row, never an AWS call: R1), audit. The
// request id of the page is the idempotency key (R7). The payload is built from the checked fields and
// nothing else, so customer text reaches the adapter only as a checked value (R11).

export type ConsolePayload =
  { ok: true; payload: Record<string, unknown> } | { ok: false; fields: Record<string, string> };

export interface ConsoleSpec {
  /** The `family` of the resource row; any other family answers like a missing row (R8). */
  family: string;
  /** The form field that carries the id of the resource. */
  idField: string;
  kind: OperationKind;
  /** Prefix of the idempotency key. */
  keyPrefix: string;
  /** The audit action. */
  audit: string;
  /** The fixed result key shown to the customer (U6). */
  done: string;
  /** A result key that depends on the final payload (a cancelled plan change says so); default `done`. */
  doneFor?(payload: Record<string, unknown>): string;
  /** The states in which the action may run (R13/R16: the lifecycle owns every other state). */
  states: readonly string[];
  /** The rate limit bucket. */
  limitKey: string;
  /**
   * A second resource of the customer that the action names (WPU-G9: the instance a bucket is opened
   * to). It is read through the scoped repository like the first one: another customer's row and a
   * missing one are one answer (R8). Its id is a checked field of the payload.
   */
  alsoOwns?: { field: string; families: readonly string[]; states: readonly string[] };
  payload(input: Record<string, unknown>): ConsolePayload;
  /**
   * WPU-G11. The action takes something away that works now (a certificate and with it the HTTPS of a
   * custom domain): it needs a fresh sign-in (U10) and the customer types the text that `typed` gives
   * for the row (the domain of the certificate). No text, or another text, is `name_mismatch`. This is
   * not an admin approval: nothing is destroyed, a certificate is free and is requested again at will.
   */
  confirm?: { typed(row: ResourceSummary): string };
  /**
   * After the row of the customer was read and its state checked: the checks that need the row or a
   * second read (the plan is in the catalog, the origin is the customer's own, the saved deployment
   * has that port), and the final payload. Throws a `Refusal` (WPU-G8).
   */
  finalize?(input: {
    payload: Record<string, unknown>;
    row: ResourceSummary;
    repos: FamilyRepos;
    session: CustomerSession;
  }): Promise<Record<string, unknown>>;
}

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export const LB_ATTRIBUTES: ConsoleSpec = {
  family: "load_balancer",
  idField: "loadBalancerId",
  kind: "set_lb_attributes",
  keyPrefix: "lb-attributes",
  audit: "lb.set_attributes",
  done: "settingsQueued",
  states: ["active"],
  limitKey: "lb",
  payload(input) {
    const fields: Record<string, string> = {};
    const payload: Record<string, unknown> = {};
    const path = clean(input["healthCheckPath"]);
    if (path !== undefined) {
      if (checkedHealthPath(path) === null) fields["healthCheckPath"] = "invalid";
      else payload["healthCheckPath"] = path;
    }
    const redirect = clean(input["httpsRedirect"]);
    if (redirect !== undefined) {
      if (redirect !== "on" && redirect !== "off") fields["httpsRedirect"] = "invalid";
      else payload["httpsRedirect"] = redirect === "on";
    }
    if (Object.keys(fields).length === 0 && Object.keys(payload).length === 0) {
      fields["healthCheckPath"] = "invalid";
    }
    return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, payload };
  },
};

export const LB_REQUEST_CERTIFICATE: ConsoleSpec = {
  family: "load_balancer",
  idField: "loadBalancerId",
  kind: "request_certificate",
  keyPrefix: "lb-cert",
  audit: "lb.request_certificate",
  done: "certificateQueued",
  states: ["active"],
  limitKey: "lb.cert",
  payload(input) {
    const domain = checkedDomainName(input["domain"]);
    return domain === null
      ? { ok: false, fields: { domain: "invalid" } }
      : { ok: true, payload: { domain } };
  },
};

export const LB_REFRESH_CERTIFICATE: ConsoleSpec = {
  family: "load_balancer",
  idField: "loadBalancerId",
  kind: "refresh_certificate",
  keyPrefix: "lb-cert-refresh",
  audit: "lb.refresh_certificate",
  done: "certificateRefreshQueued",
  states: ["active"],
  limitKey: "lb.cert",
  payload: () => ({ ok: true, payload: {} }),
};

export const DB_OPTIONS: ConsoleSpec = {
  family: "database",
  idField: "databaseId",
  kind: "set_db_options",
  keyPrefix: "db-options",
  audit: "db.set_options",
  done: "optionsQueued",
  states: ["active"],
  limitKey: "db",
  payload(input) {
    const fields: Record<string, string> = {};
    const payload: Record<string, unknown> = {};
    const window = clean(input["backupWindow"]);
    if (window !== undefined) {
      if (checkedBackupWindow(window) === null) fields["backupWindow"] = "invalid";
      else payload["backupWindow"] = window;
    }
    const maintenance = clean(input["maintenanceWindow"]);
    if (maintenance !== undefined) {
      // ddd:hh24:mi-ddd:hh24:mi in UTC, at least 30 minutes (WPU-G9).
      if (checkedMaintenanceWindow(maintenance) === null) fields["maintenanceWindow"] = "invalid";
      else payload["maintenanceWindow"] = maintenance;
    }
    const mode = clean(input["publicMode"]);
    if (mode !== undefined) {
      if (mode !== "on" && mode !== "off") fields["publicMode"] = "invalid";
      else {
        // Public mode opens the database to the internet: the customer must tick the warning.
        if (mode === "on" && input["acknowledge"] !== "yes") fields["acknowledge"] = "invalid";
        payload["publiclyAccessible"] = mode === "on";
      }
    }
    if (Object.keys(fields).length === 0 && Object.keys(payload).length === 0) {
      fields["backupWindow"] = "invalid";
    }
    return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, payload };
  },
};

export const BUCKET_VERSIONING: ConsoleSpec = {
  family: "bucket",
  idField: "bucketId",
  kind: "set_bucket_versioning",
  keyPrefix: "bucket-versioning",
  audit: "bucket.versioning",
  done: "versioningQueued",
  states: ["active"],
  limitKey: "bucket",
  payload(input) {
    const v = input["versioning"];
    return v === "Enabled" || v === "Suspended"
      ? { ok: true, payload: { versioning: v } }
      : { ok: false, fields: { versioning: "invalid" } };
  },
};

/** WPU-G9: let one instance of the customer reach the bucket, or stop it (Resource access). */
export const BUCKET_INSTANCE_ACCESS: ConsoleSpec = {
  family: "bucket",
  idField: "bucketId",
  kind: "set_bucket_resource_access",
  keyPrefix: "bucket-instance-access",
  audit: "bucket.instance_access",
  done: "instanceAccessQueued",
  states: ["active"],
  limitKey: "bucket.access",
  alsoOwns: {
    field: "instanceId",
    families: ["linux_instance", "windows_instance"],
    states: ["active", "stopped"],
  },
  finalize({ payload, row }) {
    // WPU-S6: the bucket remembers 20 instances at most. A 21st allow is refused here with a message
    // (fields.instanceId = "limit"), before an operation is queued; a listed instance and deny pass.
    if (payload["access"] === "allow") {
      const listed = configOf(row)["accessInstances"];
      const list = Array.isArray(listed) ? listed.filter((id) => typeof id === "string") : [];
      if (!list.includes(String(payload["instanceId"])) && list.length >= MAX_ACCESS_INSTANCES) {
        throw new Refusal("not_allowed", { instanceId: "limit" });
      }
    }
    return Promise.resolve(payload);
  },
  payload(input) {
    const fields: Record<string, string> = {};
    const instanceId = clean(input["instanceId"]);
    if (instanceId === undefined || !UUID.test(instanceId)) fields["instanceId"] = "invalid";
    const access = clean(input["access"]);
    if (access !== "allow" && access !== "deny") fields["access"] = "invalid";
    return Object.keys(fields).length > 0
      ? { ok: false, fields }
      : { ok: true, payload: { instanceId, access } };
  },
};

export const CDN_RESET_CACHE: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "reset_cache",
  keyPrefix: "cdn-reset",
  audit: "cdn.reset_cache",
  done: "cacheResetQueued",
  states: ["active"],
  limitKey: "cdn",
  payload: () => ({ ok: true, payload: {} }),
};

// ---------------------------------------------------------------------------------------------
// WPU-G8: container service and CDN distribution.

const LIVE = ["active", "stopped", "suspended"] as const;
const configOf = (row: ResourceSummary): Record<string, unknown> =>
  typeof row.config === "object" && row.config !== null && !Array.isArray(row.config)
    ? (row.config as Record<string, unknown>)
    : {};

function digits(value: unknown, max: number): number | null {
  return typeof value === "string" && new RegExp(`^[0-9]{1,${max}}$`).test(value.trim())
    ? Number(value.trim())
    : null;
}

/** A plan change is chosen by catalog product id; "cancel" removes a pending one. Nothing is charged now. */
function planPayload(input: Record<string, unknown>): ConsolePayload {
  if (clean(input["cancel"]) === "yes") return { ok: true, payload: { productId: null } };
  const id = clean(input["productId"]);
  return id !== undefined && UUID.test(id)
    ? { ok: true, payload: { productId: id } }
    : { ok: false, fields: { productId: "invalid" } };
}

const planDone = (payload: Record<string, unknown>): string =>
  payload["productId"] === null ? "planCancelled" : "planScheduled";

/**
 * The product must be on sale, of this family, in the Region of the resource, a plan of its own kind,
 * and another plan than the current one.
 */
function planFinalize(
  shaped: (awsId: unknown, specs: unknown) => boolean,
): NonNullable<ConsoleSpec["finalize"]> {
  return async ({ payload, row, repos }) => {
    if (payload["productId"] === null) return payload;
    if (repos.catalogProduct === undefined) throw new Refusal("unavailable");
    const config = configOf(row);
    const id = payload["productId"] as string;
    const product = await repos.catalogProduct(id);
    const current = typeof config["productId"] === "string" ? config["productId"] : row.productId;
    if (
      product === null ||
      !product.active ||
      product.family !== row.family ||
      typeof config["region"] !== "string" ||
      product.region !== config["region"] ||
      !shaped(product.awsId, product.specs) ||
      id === current
    ) {
      throw new Refusal("validation", { productId: "invalid" });
    }
    // WPU-S3: a plan whose apply failed is not scheduled again by the customer (that would clear the
    // mark and repeat the discount); another plan may be. Only an admin or a successful apply
    // removes the mark.
    if (planFailedFor(config, id)) throw new Refusal("validation", { productId: "failed" });
    // WPU-S3: and no plan is scheduled while the apply of the earlier one is on its way. A list that
    // cannot be read refuses (R16).
    if (planApplyInFlight(await repos.operations.listForResource(row.id))) {
      throw new Refusal("busy");
    }
    return payload;
  };
}

export const CONTAINER_PLAN: ConsoleSpec = {
  family: "container_service",
  idField: "containerId",
  kind: "schedule_plan_change",
  keyPrefix: "container-plan",
  audit: "container.schedule_plan",
  done: "planScheduled",
  states: LIVE,
  limitKey: "container.plan",
  doneFor: planDone,
  payload: planPayload,
  finalize: planFinalize((awsId, specs) => containerPlanFrom(awsId, specs) !== null),
};

export const CDN_PLAN: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "schedule_plan_change",
  keyPrefix: "cdn-plan",
  audit: "cdn.schedule_plan",
  done: "planScheduled",
  states: LIVE,
  limitKey: "cdn.plan",
  doneFor: planDone,
  payload: planPayload,
  finalize: planFinalize((awsId) => cdnBundleFrom(awsId) !== null),
};

/** One certificate per resource: a second request is refused (the adapter names it by the resource). */
const noCertificateYet: NonNullable<ConsoleSpec["finalize"]> = async ({ payload, row }) => {
  if (certificateFactsOf(configOf(row)["certificate"]) !== null) throw new Refusal("not_allowed");
  return payload;
};

const domainPayload = (input: Record<string, unknown>): ConsolePayload => {
  const domain = checkedContainerCertificateDomain(input["domain"]);
  return domain === null
    ? { ok: false, fields: { domain: "invalid" } }
    : { ok: true, payload: { domain } };
};

export const CONTAINER_REQUEST_CERTIFICATE: ConsoleSpec = {
  family: "container_service",
  idField: "containerId",
  kind: "request_certificate",
  keyPrefix: "container-cert",
  audit: "container.request_certificate",
  done: "certificateQueued",
  states: ["active"],
  limitKey: "container.cert",
  payload: domainPayload,
  finalize: noCertificateYet,
};

export const CONTAINER_REFRESH_CERTIFICATE: ConsoleSpec = {
  family: "container_service",
  idField: "containerId",
  kind: "refresh_certificate",
  keyPrefix: "container-cert-refresh",
  audit: "container.refresh_certificate",
  done: "certificateRefreshQueued",
  states: ["active"],
  limitKey: "container.cert",
  payload: () => ({ ok: true, payload: {} }),
};

export const CDN_REQUEST_CERTIFICATE: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "request_certificate",
  keyPrefix: "cdn-cert",
  audit: "cdn.request_certificate",
  done: "certificateQueued",
  states: ["active"],
  limitKey: "cdn.cert",
  payload: domainPayload,
  finalize: noCertificateYet,
};

export const CDN_REFRESH_CERTIFICATE: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "refresh_certificate",
  keyPrefix: "cdn-cert-refresh",
  audit: "cdn.refresh_certificate",
  done: "certificateRefreshQueued",
  states: ["active"],
  limitKey: "cdn.cert",
  payload: () => ({ ok: true, payload: {} }),
};

/** Cache behaviour: the whole policy, default plus per-path rules, from closed lists and bounded numbers. */
export const CDN_CACHE_BEHAVIORS: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "set_cache_behaviors",
  keyPrefix: "cdn-cache",
  audit: "cdn.set_cache_behaviors",
  done: "cacheQueued",
  states: ["active"],
  limitKey: "cdn.cache",
  payload(input) {
    const parsed = parseCachePolicy({
      defaultBehavior: clean(input["defaultBehavior"]),
      defaultTtl: input["defaultTtl"],
      minTtl: input["minTtl"],
      maxTtl: input["maxTtl"],
      allowedMethods: clean(input["allowedMethods"]),
      cachedMethods: clean(input["cachedMethods"]),
      cookies: clean(input["cookies"]),
      headers: clean(input["headers"]),
      queryStrings: clean(input["queryStrings"]),
      paths: typeof input["paths"] === "string" ? input["paths"] : "",
    });
    return parsed.ok
      ? { ok: true, payload: { ...parsed.value } as unknown as Record<string, unknown> }
      : { ok: false, fields: parsed.fields ?? { cache: "invalid" } };
  },
};

/** Origin change: only a server, load balancer or bucket of the SAME customer, by id (R8, R11). */
export const CDN_ORIGIN: ConsoleSpec = {
  family: "cdn",
  idField: "cdnId",
  kind: "set_cdn_origin",
  keyPrefix: "cdn-origin",
  audit: "cdn.set_origin",
  done: "originQueued",
  states: ["active"],
  limitKey: "cdn.origin",
  payload(input) {
    const id = clean(input["originId"]);
    return id !== undefined && UUID.test(id)
      ? { ok: true, payload: { originId: id } }
      : { ok: false, fields: { originId: "invalid" } };
  },
  async finalize({ payload, row, repos, session }) {
    const id = payload["originId"] as string;
    // The scoped repository answers for the customer's own rows only; another customer's id is null.
    const candidate = await repos.resources.get(id);
    const checked = checkCdnOrigin({
      customerId: session.customerId,
      requested: id,
      candidate:
        candidate === null
          ? null
          : {
              id: candidate.id,
              customerId: session.customerId,
              family: candidate.family,
              state: candidate.state,
            },
    });
    if (!checked.ok || id === configOf(row)["originId"]) {
      throw new Refusal("validation", { originId: "invalid" });
    }
    return payload;
  },
};

/**
 * The public endpoint of a container service: which container, which port, which health check path
 * (or none at all). A public endpoint is part of a deployment in Lightsail, so this makes a new
 * deployment of the SAME containers (read from the saved deployment, with their environment kept on
 * the server) with the changed endpoint.
 */
export const CONTAINER_ENDPOINT: ConsoleSpec = {
  family: "container_service",
  idField: "containerId",
  kind: "deploy_containers",
  keyPrefix: "container-endpoint",
  audit: "container.set_endpoint",
  done: "endpointQueued",
  states: ["active"],
  limitKey: "container.write",
  payload(input) {
    if (clean(input["remove"]) === "yes") return { ok: true, payload: { remove: true } };
    const fields: Record<string, string> = {};
    const container = digits(clean(input["container"]) ?? "1", 2);
    const port = digits(clean(input["port"]), 5);
    if (container === null || container < 1) fields["container"] = "invalid";
    if (port === null) fields["port"] = "invalid";
    if (Object.keys(fields).length > 0) return { ok: false, fields };
    const path = clean(input["healthCheckPath"]);
    return {
      ok: true,
      payload: { container, port, ...(path !== undefined ? { healthCheckPath: path } : {}) },
    };
  },
  async finalize({ payload, row }) {
    const saved = configOf(row)["deployment"];
    const built = withPublicEndpoint(
      saved,
      payload["remove"] === true
        ? null
        : {
            container: payload["container"] as number,
            port: payload["port"] as number,
            ...(typeof payload["healthCheckPath"] === "string"
              ? { healthCheckPath: payload["healthCheckPath"] }
              : {}),
          },
    );
    if (!built.ok) throw new Refusal("validation", built.fields ?? { endpoint: "invalid" });
    return built.value;
  },
};

// ---------------------------------------------------------------------------------------------
// WPU-G11: remove or replace a certificate, and the parameters of a database.

/** The domain of the certificate that is saved on the resource; "" when there is none. */
const certificateDomainOf = (row: ResourceSummary): string =>
  certificateFactsOf(configOf(row)["certificate"])?.domain ?? "";

const confirmDomain = { typed: certificateDomainOf };

const removeSpec = (
  family: string,
  idField: string,
  prefix: string,
  limitKey: string,
): ConsoleSpec => ({
  family,
  idField,
  kind: "remove_certificate",
  keyPrefix: `${prefix}-cert-remove`,
  audit: `${prefix}.remove_certificate`,
  done: "certificateRemoveQueued",
  states: ["active"],
  limitKey,
  confirm: confirmDomain,
  payload: () => ({ ok: true, payload: {} }),
});

/** Replace: the new domain is checked like a request; the old certificate is named by typing it. */
const replaceSpec = (
  family: string,
  idField: string,
  prefix: string,
  limitKey: string,
  domainCheck: (value: unknown) => string | null,
): ConsoleSpec => ({
  family,
  idField,
  kind: "replace_certificate",
  keyPrefix: `${prefix}-cert-replace`,
  audit: `${prefix}.replace_certificate`,
  done: "certificateReplaceQueued",
  states: ["active"],
  limitKey,
  confirm: confirmDomain,
  payload(input) {
    const domain = domainCheck(input["domain"]);
    return domain === null
      ? { ok: false, fields: { domain: "invalid" } }
      : { ok: true, payload: { domain } };
  },
  async finalize({ payload, row }) {
    // The same domain again is not a replacement.
    if (payload["domain"] === certificateDomainOf(row)) {
      throw new Refusal("validation", { domain: "invalid" });
    }
    return payload;
  },
});

export const LB_REMOVE_CERTIFICATE = removeSpec("load_balancer", "loadBalancerId", "lb", "lb.cert");
export const LB_REPLACE_CERTIFICATE = replaceSpec(
  "load_balancer",
  "loadBalancerId",
  "lb",
  "lb.cert",
  checkedDomainName,
);
export const CONTAINER_REMOVE_CERTIFICATE = removeSpec(
  "container_service",
  "containerId",
  "container",
  "container.cert",
);
export const CONTAINER_REPLACE_CERTIFICATE = replaceSpec(
  "container_service",
  "containerId",
  "container",
  "container.cert",
  checkedContainerCertificateDomain,
);
export const CDN_REMOVE_CERTIFICATE = removeSpec("cdn", "cdnId", "cdn", "cdn.cert");
export const CDN_REPLACE_CERTIFICATE = replaceSpec(
  "cdn",
  "cdnId",
  "cdn",
  "cdn.cert",
  checkedContainerCertificateDomain,
);

/** Every parameter name of the whitelist of either engine: the only form fields that are read. */
export const DB_PARAMETER_FIELDS: readonly string[] = [
  ...new Set([...DB_PARAMETER_RULES.mysql, ...DB_PARAMETER_RULES.postgres].map((r) => r.name)),
];

const savedParameters = (row: ResourceSummary) => {
  const saved = configOf(row)["parameters"];
  const rec =
    typeof saved === "object" && saved !== null && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  const items = Array.isArray(rec["items"]) ? rec["items"] : [];
  return { engine: dbEngineFrom(rec["engine"]), items };
};

/**
 * Change database parameters. The form carries a field for each parameter that can change, named by the
 * whitelist; a field that is empty or equal to the saved value is no change. The engine is the one the
 * adapter saved from the live database, and the adapter checks it again (R11, R16).
 */
export const DB_PARAMETERS: ConsoleSpec = {
  family: "database",
  idField: "databaseId",
  kind: "set_db_parameters",
  keyPrefix: "db-parameters",
  audit: "db.set_parameters",
  done: "parametersQueued",
  states: ["active"],
  limitKey: "db.parameters",
  payload(input) {
    const wanted: Record<string, unknown> = {};
    for (const name of DB_PARAMETER_FIELDS) {
      const value = clean(input[name]);
      if (value !== undefined) wanted[name] = value;
    }
    return Object.keys(wanted).length === 0
      ? { ok: false, fields: { parameters: "invalid" } }
      : { ok: true, payload: { parameters: wanted } };
  },
  async finalize({ payload, row }) {
    const saved = savedParameters(row);
    // Without a saved list there is no engine: the customer reads the list first (R16).
    if (saved.engine === null) throw new Refusal("not_allowed");
    const checked = checkedDbParameterChanges(saved.engine, payload["parameters"]);
    if (!checked.ok) throw new Refusal("validation", checked.fields ?? { parameters: "invalid" });
    const known = new Map(
      saved.items
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
        .map((i) => [i["name"], i["value"]] as const),
    );
    // A parameter the saved list does not show as changeable is not changed.
    const changeable = new Set(
      saved.items
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
        .filter((i) => i["changeable"] === true)
        .map((i) => i["name"]),
    );
    const changes: Record<string, string> = {};
    const bad: Record<string, string> = {};
    for (const c of checked.value) {
      if (!changeable.has(c.name)) bad[c.name] = "invalid";
      else if (known.get(c.name) !== c.value) changes[c.name] = c.value;
    }
    if (Object.keys(bad).length > 0) throw new Refusal("validation", bad);
    if (Object.keys(changes).length === 0) {
      throw new Refusal("validation", { parameters: "invalid" });
    }
    return { parameters: changes };
  },
};

/** Read the parameter list again (it is kept as "last known"; there is no live read from the page). */
export const DB_READ_PARAMETERS: ConsoleSpec = {
  family: "database",
  idField: "databaseId",
  kind: "read_db_parameters",
  keyPrefix: "db-parameters-read",
  audit: "db.read_parameters",
  done: "parametersReadQueued",
  states: ["active"],
  limitKey: "db.parameters",
  payload: () => ({ ok: true, payload: {} }),
};

/** Reboot the database. It is not reachable for a short time, so the customer ticks the warning. */
export const DB_REBOOT: ConsoleSpec = {
  family: "database",
  idField: "databaseId",
  kind: "reboot",
  keyPrefix: "db-reboot",
  audit: "db.reboot",
  done: "rebootQueued",
  states: ["active"],
  limitKey: "db.reboot",
  payload: (input) =>
    input["acknowledge"] === "yes"
      ? { ok: true, payload: {} }
      : { ok: false, fields: { acknowledge: "invalid" } },
};

/** The core of one console action. */
export function consoleCore(
  spec: ConsoleSpec,
): (deps: FamilyActionDeps, raw: unknown) => Promise<FamilyResult> {
  return async (deps, raw) => {
    const input = record(raw);
    const bad: Record<string, string> = {};
    const id = uuidField(input, spec.idField, bad);
    const requestId = uuidField(input, "requestId", bad);
    const built = spec.payload(input);
    if (!built.ok) Object.assign(bad, built.fields);
    return frame(
      deps,
      {
        destructive: spec.confirm !== undefined,
        limits: FAMILY_WRITE_LIMIT(spec.limitKey),
        own: { family: spec.family, id },
      },
      parseOf(bad),
      async (repos, session, owned) => {
        // Read and checked by the frame before the rate limit (R9, WPU-S6).
        const row = owned ?? (await ownResource(repos, spec.family, id));
        if (!spec.states.includes(row.state)) throw new Refusal("not_allowed");
        if (spec.confirm !== undefined) {
          const expected = spec.confirm.typed(row);
          // No saved certificate means there is nothing to take away.
          if (expected === "") throw new Refusal("not_allowed");
          const typed = typeof input["confirmName"] === "string" ? input["confirmName"].trim() : "";
          if (typed.toLowerCase() !== expected) throw new Refusal("name_mismatch");
        }
        if (spec.alsoOwns !== undefined) {
          // The second row is the customer's own or it is nothing (R8); a family or state that the
          // action does not serve answers the same way.
          const second = await repos.resources.get(
            String((built as { payload: Record<string, unknown> }).payload[spec.alsoOwns.field]),
          );
          if (
            second === null ||
            !spec.alsoOwns.families.includes(second.family) ||
            !spec.alsoOwns.states.includes(second.state)
          ) {
            throw new Refusal("not_found");
          }
        }
        const checked = (built as { ok: true; payload: Record<string, unknown> }).payload;
        const payload =
          spec.finalize === undefined
            ? checked
            : await spec.finalize({ payload: checked, row, repos, session });
        const written = await repos.operations.request({
          resourceId: row.id,
          kind: spec.kind,
          idempotencyKey: `${spec.keyPrefix}:${requestId}`,
          payload,
        });
        if (!written.ok) {
          throw new Refusal(
            written.error === "not_found"
              ? "not_found"
              : written.error === "conflict"
                ? "not_allowed"
                : "unavailable",
          );
        }
        await audit(repos, spec.audit, row.id);
        return { ok: true, done: spec.doneFor?.(payload) ?? spec.done };
      },
    );
  };
}
