import { parseDeployment, type ContainerProtocol, type Deployment } from "./container";
import { checkedDomainName } from "./console";
import type { Result } from "../types";

// Pure rules of the container service console (WPU-G8). Customer text is checked here and travels as
// a value of an AWS request, never as an AWS name or tag (R11).

const PROTOCOLS: readonly string[] = ["HTTP", "HTTPS", "TCP", "UDP"];
const MAX_PORTS = 20;

/**
 * Ports from text: numbers separated by commas or lines, each with an optional `/PROTOCOL`; a number
 * alone takes `defaultProtocol`. Null for anything that is not a port list (a number outside 1 to 65535,
 * an unknown protocol, a repeat, more than 20).
 */
export function parsePortList(
  text: string,
  defaultProtocol: string,
): { port: number; protocol: ContainerProtocol }[] | null {
  if (!PROTOCOLS.includes(defaultProtocol)) return null;
  const out: { port: number; protocol: ContainerProtocol }[] = [];
  const seen = new Set<number>();
  for (const token of text.split(/[\s,]+/)) {
    if (token === "") continue;
    const m = /^([0-9]{1,5})(?:\/([A-Za-z]{3,5}))?$/.exec(token);
    if (m === null) return null;
    const port = Number(m[1]);
    const protocol = (m[2] ?? defaultProtocol).toUpperCase();
    if (port < 1 || port > 65535 || !PROTOCOLS.includes(protocol) || seen.has(port)) return null;
    seen.add(port);
    out.push({ port, protocol: protocol as ContainerProtocol });
    if (out.length > MAX_PORTS) return null;
  }
  return out;
}

/**
 * The saved deployment (`config.deployment`, as the adapter wrote it) changed to a new public
 * endpoint, in the input shape of `parseDeployment` (the payload of `deploy_containers`). `container`
 * counts from 1; `null` removes the endpoint. The containers, their commands and their environment
 * values stay exactly as saved and travel only to the operation. The one parser of the adapter has the
 * last word (R16), so a port the container does not declare is refused.
 */
export function withPublicEndpoint(
  savedDeployment: unknown,
  endpoint: { container: number; port: number; healthCheckPath?: string } | null,
): Result<Record<string, unknown>> {
  const bad = (field: string): Result<Record<string, unknown>> => ({
    ok: false,
    error: "validation",
    fields: { [field]: "invalid" },
  });
  if (
    typeof savedDeployment !== "object" ||
    savedDeployment === null ||
    typeof (savedDeployment as { containers?: unknown }).containers !== "object" ||
    (savedDeployment as { containers?: unknown }).containers === null
  ) {
    return bad("deployment");
  }
  const containers = (savedDeployment as { containers: Record<string, unknown> }).containers;
  const names = Object.keys(containers)
    .filter((n) => /^c[0-9]{1,2}$/.test(n))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const list: Record<string, unknown>[] = [];
  for (const name of names) {
    const c = containers[name];
    if (typeof c !== "object" || c === null || Array.isArray(c)) return bad("deployment");
    const r = c as Record<string, unknown>;
    const ports =
      typeof r.ports === "object" && r.ports !== null
        ? Object.entries(r.ports as Record<string, unknown>).map(([port, protocol]) => ({
            port: Number(port),
            protocol,
          }))
        : undefined;
    list.push({
      image: r.image,
      ...(r.command !== undefined ? { command: r.command } : {}),
      ...(r.environment !== undefined ? { environment: r.environment } : {}),
      ...(ports !== undefined ? { ports } : {}),
    });
  }
  const input: Record<string, unknown> = { containers: list };
  if (endpoint !== null) {
    if (!Number.isInteger(endpoint.container) || endpoint.container < 1) return bad("container");
    input.publicEndpoint = {
      container: endpoint.container - 1,
      port: endpoint.port,
      ...(endpoint.healthCheckPath !== undefined && endpoint.healthCheckPath !== ""
        ? { healthCheckPath: endpoint.healthCheckPath }
        : {}),
    };
  }
  const parsed = parseDeployment(input);
  if (!parsed.ok) {
    return endpoint === null ? bad("deployment") : bad("endpoint");
  }
  return { ok: true, value: input };
}

export interface DeploymentHistoryEntry {
  readonly at: string;
  readonly images: readonly string[];
  readonly endpoint: boolean;
}

/**
 * What the history of deployments keeps of one deployment: the date, the images and whether it has a
 * public endpoint. Never the environment, the command or a port (R14: values may hold secrets).
 */
export function deploymentHistoryEntry(deployment: Deployment, at: Date): DeploymentHistoryEntry {
  return {
    at: at.toISOString(),
    images: Object.keys(deployment.containers)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((name) => (deployment.containers[name] as { image: string }).image),
    endpoint: deployment.publicEndpoint !== undefined,
  };
}

/** The domain of a custom domain certificate: the plain-name rule of the console. */
export function checkedContainerCertificateDomain(value: unknown): string | null {
  return checkedDomainName(value);
}
