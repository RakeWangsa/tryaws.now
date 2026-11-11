// 10.4 item 7: the cases of the isolation test, as data, so a local test can check the list and the
// real-pool test runs the same list.
export interface TcpCase {
  readonly name: string;
  readonly port: number;
  readonly expect: "blocked" | "recorded";
}

// Port 80 is closed by the template by default (WP4-T6 review): it is recorded, and it is open only
// on an instance created with the load balancer option.
export const TCP_CASES: readonly TcpCase[] = Object.freeze([
  { name: "ssh", port: 22, expect: "blocked" },
  { name: "https", port: 443, expect: "blocked" },
  { name: "mysql", port: 3306, expect: "blocked" },
  { name: "high tcp port", port: 40000, expect: "blocked" },
  { name: "http (recorded)", port: 80, expect: "recorded" },
]);

// Run by hand in tc-pool-dev; they need a load balancer, a reboot or IPv6 and are not scripted here.
export const MANUAL_CASES: readonly string[] = Object.freeze([
  "B cannot reach a UDP port on A's private IP",
  "B cannot reach a port that Docker publishes on A",
  "a load balancer health check to A passes (instance created with the load balancer option)",
  "DHCP renewal on A works after a reboot",
  "IPv6: B cannot open a port on A's IPv6 address that A's IPv6 firewall does not allow",
  "IPv6: a rule sent with IPv4 sources only leaves that port closed for IPv6",
]);

export const POOL_ENV = "TC_ISOLATION_POOL";
export const REQUIRED_POOL = "tc-pool-dev";
// A's private IP, B as user@host, and the key file that ssh uses for B (a path, never its content).
export const REQUIRED_ENV = Object.freeze([
  "TC_ISOLATION_A_PRIVATE_IP",
  "TC_ISOLATION_B_SSH",
  "TC_ISOLATION_B_KEY_FILE",
] as const);

export function skipReason(env: Record<string, string | undefined>): string | null {
  if (env[POOL_ENV] !== REQUIRED_POOL) {
    return `isolation test needs a real pool: set ${POOL_ENV}=${REQUIRED_POOL} and ${REQUIRED_ENV.join(", ")} (two instances of two test customers in ${REQUIRED_POOL}); skipped locally`;
  }
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  return missing.length === 0 ? null : `isolation test: missing ${missing.join(", ")}`;
}
