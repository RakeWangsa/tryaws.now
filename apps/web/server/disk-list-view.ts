import type { CustomerSession } from "@tc/auth";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary, SubscriptionRow } from "@tc/db";
import { autoRenewViewOf, type AutoRenewView } from "./auto-renew-view.ts";
import { resourceFacts } from "./extras-actions.ts";

// WPU-Y4: /servers/disks, every block storage disk of the customer in one list (any state, any Region, attached or
// not), so a detached disk is never out of reach. Read through the repositories of the session's customer only
// (R8): a disk's `attachedInstanceId` is shown as a server only when that server is one of the customer's own rows.
// Fix round 1: every disk owner sees the list whatever the server flag, so a disk is never out of reach. Each action
// keeps its own flag (R12): detach, destroy and attach are actions of the server family (their cores refuse with the
// server flag off) and are offered only while it is on; the auto-renew switch follows the disk flag, and its OFF
// switch always works (an "off only" switch while the flag is off, WPU-Z14). Nothing here returns an AWS account id, an ARN or a
// generated AWS name, and the names the customer typed are only text (R11, U6). The actions check everything again.

const SERVER_FAMILY = "linux_instance";
const DISK_FAMILY = "disk";
const LIVE = ["active", "stopped", "suspended"];

export interface DiskListItem {
  id: string;
  name: string;
  sizeGb: number | null;
  region: string | null;
  state: string;
  /** The customer's own server the disk is attached to; null = not attached (or not to a server of theirs). */
  attachedTo: { id: string; name: string; stopped: boolean } | null;
  /** The disk's subscription status; null = no subscription row. */
  subscriptionStatus: SubscriptionRow["status"] | null;
  autoRenew: AutoRenewView | null;
  /** Detach is offered: active, attached to the customer's server, and that server is stopped (WPU-Z19). */
  canDetach: boolean;
  /** Destroy is offered: live, not attached, its subscription active or in grace. */
  canDestroy: boolean;
  /** Free and active: the customer's live servers of the same Region it can be attached to (on their page). */
  attachTargets: { id: string; name: string }[];
}

export type DiskListScreen = { state: "ready"; disks: DiskListItem[]; requestId: string };

const nameOf = (row: ResourceSummary): string => {
  const c = row.config;
  const n =
    typeof c === "object" && c !== null ? (c as Record<string, unknown>)["displayName"] : undefined;
  return typeof n === "string" ? n.slice(0, 60) : "";
};

const ORDER: Record<string, number> = { active: 0, stopped: 0, suspended: 0, creating: 1 };

/** Pure: the list from the customer's own rows and subscriptions. A failed create (refunded) is left out. */
export function diskListOf(input: {
  rows: readonly ResourceSummary[];
  subscriptions: readonly SubscriptionRow[];
  diskFlagOn: boolean;
  /** The server family's flag: detach, destroy and attach are its actions (R12). */
  serverActionsOn: boolean;
}): DiskListItem[] {
  const on = input.serverActionsOn;
  const servers = new Map(
    input.rows.filter((r) => r.family === SERVER_FAMILY).map((r) => [r.id, r] as const),
  );
  const subscriptionOf = new Map(input.subscriptions.map((s) => [s.resourceId, s] as const));
  const liveServers = [...servers.values()].filter((s) => ["active", "stopped"].includes(s.state));
  const out: DiskListItem[] = [];
  for (const row of input.rows) {
    if (row.family !== DISK_FAMILY || row.state === "failed") continue;
    const facts = resourceFacts(row);
    const server = facts.attachedTo === null ? undefined : servers.get(facts.attachedTo);
    const subscription = subscriptionOf.get(row.id) ?? null;
    const attachedTo =
      server === undefined
        ? null
        : { id: server.id, name: nameOf(server), stopped: server.state === "stopped" };
    const free = facts.attachedTo === null;
    const paidUp = subscription !== null && ["active", "grace"].includes(subscription.status);
    out.push({
      id: row.id,
      name: facts.name,
      sizeGb: facts.sizeGb,
      region: row.region,
      state: row.state,
      attachedTo,
      subscriptionStatus: subscription?.status ?? null,
      autoRenew: autoRenewViewOf(DISK_FAMILY, row, subscription, input.diskFlagOn),
      canDetach: on && row.state === "active" && attachedTo !== null && attachedTo.stopped,
      canDestroy: on && free && LIVE.includes(row.state) && paidUp && facts.name !== "",
      attachTargets:
        on && free && row.state === "active" && paidUp
          ? liveServers
              .filter((s) => s.region === row.region)
              .map((s) => ({ id: s.id, name: nameOf(s) }))
          : [],
    });
  }
  // Live disks first, then the rest (destroyed last); newest first inside each group.
  const rank = (d: DiskListItem) => ORDER[d.state] ?? 2;
  const created = new Map(input.rows.map((r) => [r.id, r.createdAt.getTime()] as const));
  return out.sort(
    (a, b) => rank(a) - rank(b) || (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0),
  );
}

export async function loadDiskList(
  session: CustomerSession,
  requestId: string,
): Promise<DiskListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("disk list: no customer row");
    // R12, R16: a flag that is off or cannot be read offers none of its actions; the list itself is always shown.
    const serverActionsOn = (await readFeatureFlag(tx, SERVER_FAMILY, profile.market)) === true;
    const diskFlagOn = (await readFeatureFlag(tx, DISK_FAMILY, profile.market)) === true;
    const [rows, subscriptions] = await Promise.all([
      repos.resources.list(),
      repos.subscriptions.list(),
    ]);
    return {
      state: "ready",
      disks: diskListOf({ rows, subscriptions, diskFlagOn, serverActionsOn }),
      requestId,
    };
  });
}
