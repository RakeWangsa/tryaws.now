import { decideDestructive, parseContainerConfig, parseDeployment } from "@tc/core";
import {
  audit,
  displayNameOf,
  frame,
  idFields,
  limit,
  ownResource,
  parsedFrom,
  record,
  Refusal,
  text,
} from "./bucket-frame.ts";
import type { FamilyActionDeps, FamilyResult } from "./bucket-frame.ts";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the container service screens (/containers, 16.10):
// `createOrderDraft` (review), `deployContainers` and `destroyContainerService`. R9 order in each:
// authenticate, authorize (a fresh sign-in for a destructive action, U10; the flag and the
// ownership), validate, rate limit, execute, audit. Every one writes an operation row or a draft and
// nothing else (R1) and is idempotent by the request id of the page (R7). The power and the scale are
// the ones of the catalog product the customer buys; there is no number of them in any form.

const FAMILY = "container_service";
const LIVE_STATES = ["active", "stopped", "suspended"];

export const CONTAINER_WRITE_LIMIT = limit("container.write", 30, 3600);
export const CONTAINER_DESTROY_LIMIT = limit("container.destroy", 5, 3600);

/** /containers/new: the three fields of the form, nothing else, become the config (R9, R11). */
export async function createContainerDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = record(raw);
  const parsed = parseContainerConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
  });
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  const result = await deps.orders.createOrderDraft(session, {
    family: FAMILY,
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

const PROTOCOLS = ["HTTP", "HTTPS", "TCP", "UDP"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const SAMPLE_IMAGE = "nginx";

type FormDeployment =
  { ok: true; value: Record<string, unknown> } | { ok: false; fields: Record<string, string> };

function envOf(textValue: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of textValue.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry === "") continue;
    const at = entry.indexOf("=");
    if (at < 1) return null;
    out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

/**
 * The fields of the deploy form (one container: image, one port with its protocol, environment lines
 * `KEY=VALUE`, the public endpoint and its health check path) in the shape that `parseDeployment`
 * takes. The core parser has the last word; this function only finds which field is wrong, by asking
 * the same parser about each part. No field is a container name: those are generated (R11).
 */
export function deploymentFromForm(raw: unknown): FormDeployment {
  const input = record(raw);
  const image = text(input, "image");
  const portText = text(input, "port");
  const protocol = text(input, "protocol");
  const environmentText = typeof input["environment"] === "string" ? input["environment"] : "";
  const healthCheckPath = text(input, "healthCheckPath");
  const endpoint = input["publicEndpoint"] === "on";
  const fields: Record<string, string> = {};

  if (!parseDeployment({ containers: [{ image }] }).ok) fields["image"] = "invalid";

  let port: number | null = null;
  if (typeof portText === "string" && portText !== "") {
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : -1;
    if (port < 1 || port > 65535) fields["port"] = "invalid";
    if (!(PROTOCOLS as readonly unknown[]).includes(protocol)) fields["protocol"] = "invalid";
  } else if (endpoint) {
    // A public endpoint points at a port of the container.
    fields["port"] = "invalid";
  }

  const environment = envOf(environmentText);
  if (
    environment === null ||
    !parseDeployment({ containers: [{ image: SAMPLE_IMAGE, environment }] }).ok
  ) {
    fields["environment"] = "invalid";
  }

  const hasPath = typeof healthCheckPath === "string" && healthCheckPath !== "";
  if (
    endpoint &&
    hasPath &&
    !parseDeployment({
      containers: [{ image: SAMPLE_IMAGE, ports: [{ port: 80, protocol: "HTTP" }] }],
      publicEndpoint: { container: 0, port: 80, healthCheckPath },
    }).ok
  ) {
    fields["healthCheckPath"] = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const container: Record<string, unknown> = { image };
  if (port !== null) container["ports"] = [{ port, protocol: protocol as Protocol }];
  if (environment !== null && Object.keys(environment).length > 0) {
    container["environment"] = environment;
  }
  const value: Record<string, unknown> = { containers: [container] };
  if (endpoint && port !== null) {
    value["publicEndpoint"] = {
      container: 0,
      port,
      ...(hasPath ? { healthCheckPath } : {}),
    };
  }
  // The parser of the adapter has the last word (R16).
  if (!parseDeployment(value).ok) return { ok: false, fields: { deployment: "invalid" } };
  return { ok: true, value };
}

/**
 * 16.10 `deployContainers`: a new deployment of the customer's own, active service. The payload is the
 * checked form and nothing else; the environment values go to the operation only, never to the audit
 * entry or a log (R14).
 */
export async function deployContainersCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const { bad, id, requestId } = idFields(input, "containerId");
  const built = deploymentFromForm(input);
  if (!built.ok) Object.assign(bad, built.fields);
  return frame(
    deps,
    { destructive: false, limits: CONTAINER_WRITE_LIMIT },
    () => parsedFrom(bad),
    async (repos) => {
      const row = await ownResource(repos, id, FAMILY);
      if (row.state !== "active") throw new Refusal("not_allowed");
      const written = await repos.operations.request({
        resourceId: row.id,
        kind: "deploy_containers",
        idempotencyKey: `container-deploy:${requestId}`,
        payload: (built as { ok: true; value: Record<string, unknown> }).value,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, "container.deploy", row.id);
      return { ok: true, done: "deployQueued" };
    },
  );
}

/**
 * 16.10 `destroyContainerService` (U10, R13; enters the approval queue until 2026-12-01). A service
 * has no snapshot: its settings stay in `resources.config` (11).
 */
export async function destroyContainerServiceCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const { bad, id, requestId } = idFields(input, "containerId");
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: CONTAINER_DESTROY_LIMIT },
    () => parsedFrom(bad),
    async (repos) => {
      const row = await ownResource(repos, id, FAMILY);
      if (!LIVE_STATES.includes(row.state)) throw new Refusal("not_allowed");
      const name = displayNameOf(row.config);
      if (name === "" || typed !== name) throw new Refusal("name_mismatch");
      if (
        !decideDestructive("destroy", {
          subscriptionStatus: "retained",
          family: row.family,
          hasFinalSnapshot: false,
          isFinalBackup: false,
        })
      ) {
        throw new Refusal("not_allowed");
      }
      const queued = await repos.subscriptions.requestDestroy({
        resourceId: row.id,
        idempotencyKey: `destroy:${requestId}`,
        withFinalSnapshot: false,
      });
      if (!queued.ok) {
        throw new Refusal(
          queued.error === "not_found"
            ? "not_found"
            : queued.error === "conflict"
              ? "not_allowed"
              : "unavailable",
        );
      }
      await audit(repos, "container.destroy", row.id);
      return { ok: true, done: "destroyQueued", approval: queued.value.needsApproval };
    },
  );
}
