import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import type { Result } from "../types";

export interface ContainerConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
}

export const CONTAINER_POWERS = Object.freeze([
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
] as const);
export type ContainerPower = (typeof CONTAINER_POWERS)[number];
export const MAX_SCALE = 20;

export interface ContainerPlan {
  readonly power: ContainerPower;
  readonly scale: number;
}

export type ContainerProtocol = "HTTP" | "HTTPS" | "TCP" | "UDP";
export interface DeploymentContainer {
  readonly image: string;
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly ports?: Readonly<Record<string, ContainerProtocol>>;
}
/** The shape CreateContainerServiceDeployment takes. The container names are generated (R11). */
export interface Deployment {
  readonly containers: Readonly<Record<string, DeploymentContainer>>;
  readonly publicEndpoint?: {
    readonly containerName: string;
    readonly containerPort: number;
    readonly healthCheckPath?: string;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseContainerConfig(raw: unknown): Result<ContainerConfig> {
  const input = isRecord(raw) ? raw : {};
  const { productId, region, displayName } = input;
  const fields: Record<string, string> = {};
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
    },
  };
}

/**
 * Power and scale of a catalog product: the power is the catalog `aws_id`, the scale a field of
 * `specs` (VERIFY the shape of the synced container rows). null on any surprise (R16).
 */
export function containerPlanFrom(awsId: unknown, specs: unknown): ContainerPlan | null {
  if (typeof awsId !== "string" || !(CONTAINER_POWERS as readonly string[]).includes(awsId)) {
    return null;
  }
  if (!isRecord(specs)) return null;
  const scale = specs.scale;
  if (typeof scale !== "number" || !Number.isInteger(scale) || scale < 1 || scale > MAX_SCALE) {
    return null;
  }
  return { power: awsId as ContainerPower, scale };
}

// Public registries only at launch: a private registry needs a registry login, which is account-wide
// and is never issued (10.3).
const PUBLIC_HOSTS = new Set(["docker.io", "ghcr.io", "quay.io", "public.ecr.aws"]);
const COMPONENT = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const IMAGE = new RegExp(
  `^${COMPONENT}(?:/${COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// No control characters.
const CONTROL = {
  test(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  },
};
const HEALTH_PATH = /^\/[A-Za-z0-9._~\-/]{0,200}$/;
const PROTOCOLS = new Set(["HTTP", "HTTPS", "TCP", "UDP"]);
const MAX_CONTAINERS = 10;

function publicImage(image: unknown): image is string {
  if (typeof image !== "string" || image.length === 0 || image.length > 255) return false;
  if (!IMAGE.test(image)) return false;
  const first = image.split("/")[0] as string;
  const isHost = image.includes("/") && (first.includes(".") || first === "localhost");
  return !isHost || PUBLIC_HOSTS.has(first);
}

function parseContainer(raw: unknown): { value: DeploymentContainer; ports: number[] } | null {
  if (!isRecord(raw) || !publicImage(raw.image)) return null;
  let command: string[] | undefined;
  if (raw.command !== undefined && raw.command !== null) {
    const c = raw.command;
    if (!Array.isArray(c) || c.length > 50) return null;
    if (!c.every((x) => typeof x === "string" && x.length <= 500 && !CONTROL.test(x))) return null;
    command = [...(c as string[])];
  }
  let environment: Record<string, string> | undefined;
  if (raw.environment !== undefined && raw.environment !== null) {
    if (!isRecord(raw.environment)) return null;
    const entries = Object.entries(raw.environment);
    if (entries.length > 50) return null;
    environment = {};
    for (const [k, v] of entries) {
      if (!ENV_KEY.test(k) || typeof v !== "string" || v.length > 2000 || CONTROL.test(v)) {
        return null;
      }
      environment[k] = v;
    }
  }
  let ports: Record<string, ContainerProtocol> | undefined;
  const numbers: number[] = [];
  if (raw.ports !== undefined && raw.ports !== null) {
    if (!Array.isArray(raw.ports) || raw.ports.length > 20) return null;
    ports = {};
    for (const p of raw.ports as unknown[]) {
      if (!isRecord(p)) return null;
      const { port, protocol } = p;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
      }
      if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) return null;
      ports[String(port)] = protocol as ContainerProtocol;
      numbers.push(port);
    }
  }
  return {
    value: {
      image: raw.image,
      ...(command ? { command } : {}),
      ...(environment ? { environment } : {}),
      ...(ports ? { ports } : {}),
    },
    ports: numbers,
  };
}

/**
 * The payload of `deploy_containers`, or the deployment saved in the resource config. Input from the
 * web tier: public images only, bounded fields, container names generated as c1..cN (R11).
 */
export function parseDeployment(raw: unknown): Result<Deployment> {
  const bad: Result<Deployment> = {
    ok: false,
    error: "validation",
    fields: { deployment: "invalid" },
  };
  if (!isRecord(raw) || !Array.isArray(raw.containers)) return bad;
  const list = raw.containers as unknown[];
  if (list.length < 1 || list.length > MAX_CONTAINERS) return bad;
  const containers: Record<string, DeploymentContainer> = {};
  const declared: number[][] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseContainer(list[i]);
    if (parsed === null) return bad;
    containers[`c${i + 1}`] = parsed.value;
    declared.push(parsed.ports);
  }
  const result: {
    containers: Record<string, DeploymentContainer>;
    publicEndpoint?: Deployment["publicEndpoint"];
  } = { containers };
  const ep = raw.publicEndpoint;
  if (ep !== undefined && ep !== null) {
    if (!isRecord(ep)) return bad;
    const { container, port, healthCheckPath } = ep;
    if (typeof container !== "number" || !Number.isInteger(container)) return bad;
    if (container < 0 || container >= list.length) return bad;
    if (typeof port !== "number" || !(declared[container] as number[]).includes(port)) return bad;
    if (healthCheckPath !== undefined && healthCheckPath !== null) {
      if (typeof healthCheckPath !== "string" || !HEALTH_PATH.test(healthCheckPath)) return bad;
    }
    result.publicEndpoint = {
      containerName: `c${container + 1}`,
      containerPort: port,
      ...(typeof healthCheckPath === "string" ? { healthCheckPath } : {}),
    };
  }
  return { ok: true, value: result };
}

export interface ResolvedContainer {
  readonly family: "container_service";
  readonly productId: string;
  readonly region: string;
  readonly featureFlag: string;
  readonly awsPriceUsd: string;
  readonly facts: ProductFacts;
  readonly needs: readonly CapacityNeed[];
  readonly resourceConfig: Readonly<Record<string, unknown>>;
}

/**
 * A container service row of the catalog. The power and the scale must read back through
 * containerPlanFrom, otherwise nothing is sold (R16). The config holds three fields: the deployment
 * is a later, separate request (deploy_containers).
 */
export function resolveContainer(
  config: ContainerConfig,
  product: CatalogProduct,
): Result<ResolvedContainer> {
  if (
    product.id !== config.productId ||
    product.family !== "container_service" ||
    !product.active ||
    product.region !== config.region ||
    containerPlanFrom(product.awsId, product.specs) === null
  ) {
    return { ok: false, error: "validation", fields: { productId: "unavailable" } };
  }
  return {
    ok: true,
    value: {
      family: "container_service",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      facts: { bundleUsd: product.awsPriceUsd, windows: false, staticIps: 0 },
      needs: [{ quotaCode: "container_service", amount: 1 }],
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
      },
    },
  };
}
