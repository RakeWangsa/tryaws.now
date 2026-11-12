import { checkedBackupWindow, checkedDomainName, checkedHealthPath } from "@tc/core";
import type { OperationKind } from "@tc/core";
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
import type { FamilyActionDeps, FamilyResult } from "./family-actions.ts";

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
      async (repos) => {
        const row = await ownResource(repos, spec.family, id);
        if (!spec.states.includes(row.state)) throw new Refusal("not_allowed");
        const written = await repos.operations.request({
          resourceId: row.id,
          kind: spec.kind,
          idempotencyKey: `${spec.keyPrefix}:${requestId}`,
          payload: (built as { ok: true; payload: Record<string, unknown> }).payload,
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
