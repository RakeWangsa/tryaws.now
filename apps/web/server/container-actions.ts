import { decideDestructive, parseContainerConfig, parseDeployment, parsePortList } from "@tc/core";
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
const SAMPLE_IMAGE = "nginx";
/** The deploy form offers three containers; the first is required, the others are optional. */
export const FORM_CONTAINERS = 3;

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

/** One argument per line; an empty line is dropped. The parser of the core checks every argument. */
function commandOf(textValue: string): string[] {
  return textValue
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "");
}

const str = (input: Record<string, unknown>, key: string): string => {
  const v = input[key];
  return typeof v === "string" ? v : "";
};

const digits = (value: string): number | null =>
  /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : null;

/**
 * The fields of the deploy form in the shape that `parseDeployment` takes: up to three containers
 * (`image`, `port`, `protocol`, `environment`, `command`, and the same names with 2 or 3 after them),
 * the public endpoint (which container, which port, a health check path). A `port` field holds one or
 * more ports, `80` or `80, 8080/TCP`; a number alone takes the chosen protocol. The core parser has
 * the last word; this function only finds which field is wrong, by asking the same parser about each
 * part. No field is a container name: those are generated (R11).
 */
export function deploymentFromForm(raw: unknown): FormDeployment {
  const input = record(raw);
  const fields: Record<string, string> = {};
  const endpoint = input["publicEndpoint"] === "on";
  const healthCheckPath = str(input, "healthCheckPath").trim();

  const containers: Record<string, unknown>[] = [];
  const declared: number[][] = [];
  const formNumber: number[] = [];
  const brokenPorts: boolean[] = [];
  for (let n = 1; n <= FORM_CONTAINERS; n++) {
    const s = n === 1 ? "" : String(n);
    const image = str(input, `image${s}`).trim();
    const portText = str(input, `port${s}`);
    const protocol = str(input, `protocol${s}`).trim() || "HTTP";
    const environmentText = str(input, `environment${s}`);
    const commandText = str(input, `command${s}`);
    const touched =
      image !== "" ||
      portText.trim() !== "" ||
      environmentText.trim() !== "" ||
      commandText.trim() !== "";
    // The optional containers are left out when nothing was typed for them.
    if (n > 1 && !touched) continue;

    if (!parseDeployment({ containers: [{ image }] }).ok) fields[`image${s}`] = "invalid";

    let ports: { port: number; protocol: string }[] = [];
    let broken = false;
    if (portText.trim() !== "") {
      if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
        fields[`protocol${s}`] = "invalid";
        broken = true;
      } else {
        const parsed = parsePortList(portText, protocol);
        if (parsed === null) {
          fields[`port${s}`] = "invalid";
          broken = true;
        } else ports = parsed;
      }
    }

    const environment = envOf(environmentText);
    if (
      environment === null ||
      !parseDeployment({ containers: [{ image: SAMPLE_IMAGE, environment }] }).ok
    ) {
      fields[`environment${s}`] = "invalid";
    }

    const command = commandOf(commandText);
    if (
      command.length > 0 &&
      !parseDeployment({ containers: [{ image: SAMPLE_IMAGE, command }] }).ok
    ) {
      fields[`command${s}`] = "invalid";
    }

    const container: Record<string, unknown> = { image };
    if (ports.length > 0) container["ports"] = ports;
    if (environment !== null && Object.keys(environment).length > 0) {
      container["environment"] = environment;
    }
    if (command.length > 0) container["command"] = command;
    containers.push(container);
    declared.push(ports.map((p) => p.port));
    formNumber.push(n);
    brokenPorts.push(broken);
  }

  let publicEndpoint: Record<string, unknown> | undefined;
  if (endpoint) {
    const choice = str(input, "endpointContainer").trim();
    const wanted = choice === "" ? 1 : digits(choice);
    const index = wanted === null ? -1 : formNumber.indexOf(wanted);
    if (index < 0) fields["endpointContainer"] = "invalid";
    else {
      const ports = declared[index] as number[];
      const portField = `port${wanted === 1 ? "" : String(wanted)}`;
      const given = str(input, "endpointPort").trim();
      const port = given === "" ? ports[0] : digits(given);
      if (brokenPorts[index] === true) {
        // the port field of that container was already named
      } else if (port === undefined || port === null) {
        // A public endpoint points at a port of the container.
        fields[portField] = "invalid";
      } else if (!ports.includes(port)) {
        fields[given === "" ? portField : "endpointPort"] = "invalid";
      } else {
        publicEndpoint = {
          container: index,
          port,
          ...(healthCheckPath !== "" ? { healthCheckPath } : {}),
        };
      }
    }
    if (
      healthCheckPath !== "" &&
      !parseDeployment({
        containers: [{ image: SAMPLE_IMAGE, ports: [{ port: 80, protocol: "HTTP" }] }],
        publicEndpoint: { container: 0, port: 80, healthCheckPath },
      }).ok
    ) {
      fields["healthCheckPath"] = "invalid";
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const value: Record<string, unknown> = { containers };
  if (publicEndpoint !== undefined) value["publicEndpoint"] = publicEndpoint;
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
