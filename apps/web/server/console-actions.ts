import type { CustomerSession } from "@tc/auth";
import {
  cdnBundleFrom,
  checkCdnOrigin,
  checkedBackupWindow,
  checkedContainerCertificateDomain,
  checkedDomainName,
  checkedHealthPath,
  containerPlanFrom,
  parseCachePolicy,
  withPublicEndpoint,
} from "@tc/core";
import type { OperationKind } from "@tc/core";
import type { ResourceSummary } from "@tc/db";
import { certificateFactsOf } from "./console-view.ts";
import {
  FAMILY_WRITE_LIMIT,
  Refusal,
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
  /** The states in which the action may run (R13/R16: the lifecycle owns every other state). */
  states: readonly string[];
  /** The rate limit bucket. */
  limitKey: string;
  payload(input: Record<string, unknown>): ConsolePayload;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
      { destructive: false, limits: FAMILY_WRITE_LIMIT(spec.limitKey) },
      parseOf(bad),
      async (repos, session) => {
        const row = await ownResource(repos, spec.family, id);
        if (!spec.states.includes(row.state)) throw new Refusal("not_allowed");
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
        return { ok: true, done: spec.done };
      },
    );
  };
}
