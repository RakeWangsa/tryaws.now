import net from "node:net";

// Not covered: a worker thread (it has its own `net`), UDP (`dgram`), a direct `dns.lookup` or
// `dns.resolve`, and a child process. Nothing in this package uses them, and the SDK clients for
// Lightsail and STS do not. A later task that adds one of them must block it as well.

/** Every blocked connection attempt: `<host>:<port>`, `[<ipv6>]:<port>` or `unix:<path>`. */
export const blockedConnections: string[] = [];

const GUARD_MARK = Symbol.for("tc.aws.network-guard");

function target(args: unknown[]): { entry: string; label: string } {
  const first = args[0];
  const o = (
    Array.isArray(first)
      ? first[0]
      : typeof first === "object" && first !== null
        ? first
        : typeof first === "string" && args[1] === undefined
          ? { path: first }
          : { port: first, host: args[1] }
  ) as { host?: string; servername?: string; port?: unknown; path?: string };
  if (typeof o.path === "string") return { entry: `unix:${o.path}`, label: o.path };
  const host = o.host ?? o.servername ?? "localhost";
  const shown = host.includes(":") ? `[${host}]` : host;
  return { entry: `${shown}:${String(o.port)}`, label: host };
}

function guardedConnect(this: unknown, ...args: unknown[]): never {
  const { entry, label: host } = target(args);
  blockedConnections.push(entry);
  throw Object.assign(new Error(`network blocked in packages/aws tests: ${host}`), {
    code: "ERR_TC_NETWORK_BLOCKED",
  });
}
(guardedConnect as unknown as Record<symbol, boolean>)[GUARD_MARK] = true;

/** True while `net.Socket.prototype.connect` is the guard's function. */
export function isNetworkGuardInstalled(): boolean {
  const current = net.Socket.prototype.connect as unknown as Record<symbol, boolean>;
  return current[GUARD_MARK] === true;
}

/**
 * Replaces `net.Socket.prototype.connect` with a function that records the target and throws.
 * Returns a restore function that puts back what was there before this call. Installing twice is
 * safe: the second restore puts back the first guard, and only the first restore reaches the
 * original `connect`.
 */
export function installNetworkGuard(): () => void {
  const previous = net.Socket.prototype.connect;
  net.Socket.prototype.connect = guardedConnect as unknown as typeof net.Socket.prototype.connect;
  return () => {
    net.Socket.prototype.connect = previous;
  };
}
