import { lifecycleRepo, serverStatusForDisk, type GuardFacts, type RunView, type Tx } from "@tc/db";

export type { GuardFacts } from "@tc/db";

// R13 and section 11. A family that has a snapshot needs a final one before it is destroyed. A
// family with no snapshot (load balancer, container service, CDN, DNS) keeps its settings in
// resources.config and is created again from it (owner decision 36, interim). The names are the
// `family` values of resources; a family on neither list is refused (R16).
export const SNAPSHOT_FAMILIES: readonly string[] = Object.freeze([
  "linux_instance",
  "windows_instance",
  "database",
  "disk",
]);
export const KEPT_CONFIG_FAMILIES: readonly string[] = Object.freeze([
  "load_balancer",
  "container_service",
  "cdn",
  "dns",
  // WPU-G6: the `family` value of a hosted zone is dns_zone; its records stay in resources.config.
  "dns_zone",
]);

// Pure. The subscription state allows the action and a final snapshot exists where the product
// supports one. Only the two kinds the lifecycle queues are known here; any other destructive kind
// is refused until its owner extends this table (R16).
export function decideDestructive(kind: string, facts: GuardFacts): boolean {
  if (kind === "destroy") {
    if (facts.subscriptionStatus !== "retained") return false;
    // WPU-Y4 fix round 2: a disk destroyed with its server only while that server is still retained (a revived
    // server keeps its disks; another customer's id or a missing server is a refusal).
    if (facts.withServerStatus !== undefined && facts.withServerStatus !== "retained") return false;
    if (SNAPSHOT_FAMILIES.includes(facts.family)) return facts.hasFinalSnapshot;
    return KEPT_CONFIG_FAMILIES.includes(facts.family);
  }
  // WPU-B3: a create that failed never held customer data, so the final snapshot is not asked; the
  // resource must be `failed` and its subscription `ended` (the automatic reversal set both).
  if (kind === "cleanup_failed_create") {
    if (facts.resourceState !== "failed" || facts.subscriptionStatus !== "ended") return false;
    return SNAPSHOT_FAMILIES.includes(facts.family) || KEPT_CONFIG_FAMILIES.includes(facts.family);
  }
  if (kind === "purge_snapshots") return facts.subscriptionStatus === "ended";
  // WP5-T6: a customer's manual backup. The row is a `backup` child, it has no subscription of its
  // own and outlives its server. A final backup is never deleted by this kind: destroy relies on it (R13).
  if (kind === "delete_backup") return facts.family === "backup" && !facts.isFinalBackup;
  return false;
}

// The DestructiveGuard of functions/provisioner: reads the facts in the claim transaction and has
// no effect outside the database.
export async function destructiveGuard(tx: Tx, view: RunView): Promise<boolean> {
  const facts = await lifecycleRepo(tx).resourceOfOperation(view.operation.resourceId);
  if (facts === null) return false;
  if (view.operation.kind === "destroy" && facts.family === "disk") {
    const serverId = withServerOf(view.operation.payload, view.resource?.config);
    if (serverId === null) return false;
    if (serverId !== undefined) {
      const withServerStatus = await serverStatusForDisk(tx, {
        diskId: view.operation.resourceId,
        serverId,
      });
      return decideDestructive(view.operation.kind, { ...facts, withServerStatus });
    }
  }
  return decideDestructive(view.operation.kind, facts);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * WPU-Y4 fix round 2. The server a disk destroy is tied to: the payload's `withServer`, else the disk's mark
 * `retainedWithServer.serverId`. undefined = none; null = a value that is not an id (refused, R16). Pure.
 */
export function withServerOf(payload: unknown, config: unknown): string | null | undefined {
  const read = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
  const p =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (p["withServer"] !== undefined) return read(p["withServer"]);
  const c =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const mark = c["retainedWithServer"];
  if (mark === undefined || mark === null) return undefined;
  return typeof mark === "object" ? read((mark as Record<string, unknown>)["serverId"]) : null;
}
