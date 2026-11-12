import net from "node:net";
import { BOOTSTRAP_BEACON_PORT, BOOTSTRAP_OK_MARKER, isValidCidr } from "./bootstrap";

// WPU-G1. The platform side of the bootstrap marker (decision 110, option a): a TCP connection to
// the beacon of the instance (see BOOTSTRAP_BEACON_PORT) and a read of at most 64 bytes. The
// verdict is only ever "present" (the exact marker) or "pending" (everything else). The adapter
// bounds the waiting (20 minutes) and then fails the create, so a script that failed, a beacon that
// never started or an answer that is not the marker all end in a refusal to hand over (R16).
// Nothing here reads a customer value: the host must be a public dotted IPv4 address that AWS
// reported for the instance, never a name.

export type BeaconConnect = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<string | null>;

const MAX_BYTES = 64;
const DEFAULT_TIMEOUT_MS = 4000;

/** The real transport: connect, read until close or 64 bytes or the timeout. null = no connection. */
export const connectBeacon: BeaconConnect = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    // The idle timeout alone is reset by every byte, so a peer that drips one byte at a time could
    // hold the probe open. The absolute deadline bounds the whole exchange (R16).
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    deadline = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= MAX_BYTES) finish(Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8"));
    });
    socket.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    socket.on("close", () =>
      finish(chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8")),
    );
    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
  });

export function beaconVerdict(reply: string | null): "present" | "pending" {
  return reply !== null && reply.replace(/\n$/, "") === BOOTSTRAP_OK_MARKER ? "present" : "pending";
}

/** A dotted IPv4 literal outside private, loopback, link-local, shared, multicast and reserved space. */
export function isPublicIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
  if (m === null) return false;
  const [a, b, c, d] = m.slice(1, 5).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((o) => o > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

const MAX_SOURCES = 10;
const MIN_PREFIX = 16;

/**
 * The public addresses the probe connects from (the NAT gateways of the VPC), as a comma list of
 * CIDRs. null = not configured or unsafe: nothing is opened (R16). Never wider than /16, never a
 * private range, never 0.0.0.0/0.
 */
export function parseProbeSources(raw: string | undefined): readonly string[] | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.length > MAX_SOURCES) return null;
  for (const part of parts) {
    if (!isValidCidr(part)) return null;
    const [address, prefix] = part.split("/") as [string, string];
    if (Number(prefix) < MIN_PREFIX) return null;
    if (!isPublicIpv4(address)) return null;
  }
  return Object.freeze(parts);
}

export interface BeaconMarkerOptions {
  readonly connect?: BeaconConnect;
  readonly timeoutMs?: number;
}

/** The `bootstrapMarker` dependency of the Linux adapter, read through the beacon. */
export function createBeaconMarker(options: BeaconMarkerOptions = {}) {
  const connect = options.connect ?? connectBeacon;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (input: {
    readonly instanceName: string;
    readonly region: string;
    readonly publicIp?: string | null;
  }): Promise<"present" | "pending" | "absent"> => {
    if (!isPublicIpv4(input.publicIp)) return "pending";
    try {
      return beaconVerdict(await connect(input.publicIp, BOOTSTRAP_BEACON_PORT, timeoutMs));
    } catch {
      // A refused or reset connection is what a booting instance looks like.
      return "pending";
    }
  };
}
