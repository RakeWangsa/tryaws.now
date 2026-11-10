import net from "node:net";

/** Every blocked connection attempt, as `<host>:<port>`. */
export const blockedConnections: string[] = [];

const GUARD_MARK = Symbol.for("tc.aws.network-guard");

function target(args: unknown[]): string {
  const first = args[0];
  const o = (
    Array.isArray(first)
      ? first[0]
      : typeof first === "object" && first !== null
        ? first
        : { port: first, host: args[1] }
  ) as { host?: string; servername?: string; port?: unknown };
  return `${o.host ?? o.servername ?? "localhost"}:${String(o.port)}`;
}

function guardedConnect(this: unknown, ...args: unknown[]): never {
  const entry = target(args);
  blockedConnections.push(entry);
  const host = entry.slice(0, entry.lastIndexOf(":"));
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
