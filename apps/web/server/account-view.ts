import type { CustomerSession } from "@tc/auth";
import { groupSnapshots, usageSummary } from "@tc/core";
import type { UsageSummary } from "@tc/core";
import { customerRepos, readFeatureFlag, withTx } from "@tc/db";
import type { ResourceSummary } from "@tc/db";
import { MAX_MANUAL_BACKUPS, resourceFacts } from "./extras-actions.ts";
import { DAY_MS, RENEWAL_WINDOW_DAYS, parsePriceLines, restorePlansFor } from "./extras-view.ts";
import type { BackupItem } from "./extras-view.ts";
import { serverConfigOf } from "./servers-view.ts";
import type { PlanOption } from "./servers-view.ts";

// What the pages /snapshots, /static-ips and /billing show (WPU-G5), read through the repositories of
// the session's customer only (R8). A database error is thrown, never answered with an empty list
// (R16). Nothing here returns an AWS account id, an ARN, a generated AWS name or an error text of AWS
// (U6, R11): resource configs are read field by field. No action lives here: the pages use the
// actions of the server page (createBackup, deleteBackup, restoreToNewServer, attach and detach IP).

const LINUX = "linux_instance";
const WINDOWS = "windows_instance";
const LIVE = ["active", "stopped", "suspended"];
const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];
const CONFLICTING = [
  "reboot",
  "stop",
  "start",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
];
/** At most this many servers get restore plans on the page (each is a priced catalog read). */
const MAX_GROUPS = 25;

const isDead = (row: ResourceSummary): boolean =>
  row.state === "destroyed" || row.state === "failed";
const nameOf = (row: ResourceSummary): string =>
  serverConfigOf(row.config).displayName || resourceFacts(row).name;

// ----- Snapshots -------------------------------------------------------------------------------

export interface SnapshotServer {
  id: string;
  name: string;
  region: string | null;
  state: string;
  live: boolean;
  /** A new snapshot can be taken: the server is live and the limit of manual snapshots is not reached. */
  canSnapshot: boolean;
}

export interface SnapshotGroupView {
  server: SnapshotServer;
  items: BackupItem[];
  manual: number;
  /** restoreToNewServer: plans of the server's Region that fit the disk; empty = nothing is offered. */
  plans: PlanOption[];
}

export type SnapshotsScreen =
  | { state: "flag_off" }
  | {
      state: "ready";
      requestId: string;
      /** Servers a snapshot can be taken from now (the create form). */
      servers: { id: string; name: string; region: string | null }[];
      groups: SnapshotGroupView[];
    };

export async function loadSnapshots(
  session: CustomerSession,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<SnapshotsScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("snapshots: no customer row");
    if ((await readFeatureFlag(tx, LINUX, profile.market)) !== true) return { state: "flag_off" };
    const rows = await repos.resources.list();
    const servers = rows.filter((r) => r.family === LINUX && r.state !== "failed");
    const byId = new Map(servers.map((s) => [s.id, s]));
    const snapshots = rows
      .filter((r) => r.family === "backup" && !isDead(r) && byId.has(r.parentResourceId ?? ""))
      .map((r) => ({
        id: r.id,
        parentId: r.parentResourceId,
        state: r.state,
        createdAt: r.createdAt,
        final: resourceFacts(r).final,
        row: r,
      }));
    const itemOf = new Map(
      snapshots.map((s): [string, BackupItem] => {
        const f = resourceFacts(s.row);
        return [
          s.id,
          {
            id: s.id,
            name: f.name,
            sizeGb: f.sizeGb,
            createdAt: s.createdAt,
            state: s.state,
            final: f.final,
          },
        ];
      }),
    );
    const groups = groupSnapshots(snapshots).slice(0, MAX_GROUPS);

    const cache = new Map<string, PlanOption[]>();
    const out: SnapshotGroupView[] = [];
    for (const g of groups) {
      const server = byId.get(g.parentId) as ResourceSummary;
      const live = LIVE.includes(server.state);
      const key = `${server.productId ?? ""}|${server.region ?? ""}`;
      let plans = cache.get(key);
      if (plans === undefined) {
        plans =
          g.restorable.length > 0 ? await restorePlansFor(tx, profile.market, server, now) : [];
        cache.set(key, plans);
      }
      out.push({
        server: {
          id: server.id,
          name: serverConfigOf(server.config).displayName,
          region: server.region,
          state: server.state,
          live,
          canSnapshot: live && g.manual < MAX_MANUAL_BACKUPS,
        },
        items: g.items.map((i) => itemOf.get(i.id) as BackupItem),
        manual: g.manual,
        plans,
      });
    }
    return {
      state: "ready",
      requestId,
      servers: servers
        .filter((s) => LIVE.includes(s.state))
        .map((s) => ({ id: s.id, name: serverConfigOf(s.config).displayName, region: s.region })),
      groups: out,
    };
  });
}

// ----- Static IPs ------------------------------------------------------------------------------

export interface StaticIpItem {
  serverId: string;
  name: string;
  region: string | null;
  address: string | null;
  attached: boolean;
  serverState: string;
  family: string;
  /** A power, firewall or static IP operation is on its way: the forms wait for it. */
  busy: boolean;
}

export type StaticIpsScreen =
  { state: "flag_off" } | { state: "ready"; requestId: string; items: StaticIpItem[] };

export async function loadStaticIps(
  session: CustomerSession,
  requestId: string,
): Promise<StaticIpsScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("static-ips: no customer row");
    if ((await readFeatureFlag(tx, LINUX, profile.market)) !== true) return { state: "flag_off" };
    const windowsOn = (await readFeatureFlag(tx, WINDOWS, profile.market)) === true;
    const [rows, operations] = await Promise.all([
      repos.resources.list(),
      repos.operations.listRecent(50),
    ]);
    const busyIds = new Set(
      operations
        .filter((o) => IN_FLIGHT.includes(o.state) && CONFLICTING.includes(o.kind))
        .map((o) => o.resourceId),
    );
    const items = rows
      .filter(
        (r) =>
          (r.family === LINUX || (r.family === WINDOWS && windowsOn)) && LIVE.includes(r.state),
      )
      .map((r): StaticIpItem => {
        const config = serverConfigOf(r.config);
        const raw =
          typeof r.config === "object" && r.config !== null
            ? (r.config as Record<string, unknown>)
            : {};
        // A server is created with its static IP attached; only a detach turns it off.
        const attached = raw["staticIpAttached"] !== false;
        return {
          serverId: r.id,
          name: config.displayName,
          region: r.region,
          address: attached ? config.publicIp : null,
          attached,
          serverState: r.state,
          family: r.family,
          busy: busyIds.has(r.id),
        };
      });
    return { state: "ready", requestId, items };
  });
}

// ----- Billing and usage -----------------------------------------------------------------------

export interface BillingItem {
  resourceId: string;
  name: string;
  family: string;
  status: string;
  termDays: number;
  periodEnd: Date;
  autoRenew: boolean;
  /** The price of one term in paisa; null when the stored breakdown is not readable (R16). */
  amountMinor: bigint | null;
}

export interface BillingScreen {
  state: "ready";
  balanceMinor: bigint;
  usage: UsageSummary;
  items: BillingItem[];
  /** The renewals of the next 7 days cost more than the wallet holds. */
  lowBalance: boolean;
}

export async function loadBilling(session: CustomerSession, now: Date): Promise<BillingScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [wallet, resources, subs] = await Promise.all([
      repos.wallet.view(),
      repos.resources.list(),
      repos.subscriptions.list(),
    ]);
    const byId = new Map(resources.map((r) => [r.id, r]));
    const items = subs.map((s): BillingItem => {
      const resource = byId.get(s.resourceId);
      return {
        resourceId: s.resourceId,
        name: resource === undefined ? "" : nameOf(resource),
        family: resource?.family ?? "",
        status: s.status,
        termDays: s.termDays,
        periodEnd: s.periodEnd,
        autoRenew: s.autoRenew,
        amountMinor: parsePriceLines(s.priceSnapshot)?.totalMinor ?? null,
      };
    });
    const balance = wallet?.balanceMinor ?? 0n;
    const horizon = now.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS;
    const dueTotal = items
      .filter(
        (i) =>
          i.status === "active" &&
          i.periodEnd.getTime() >= now.getTime() &&
          i.periodEnd.getTime() <= horizon,
      )
      .reduce((sum, i) => sum + (i.amountMinor ?? 0n), 0n);
    return {
      state: "ready",
      balanceMinor: balance,
      usage: usageSummary(items),
      items,
      lowBalance: dueTotal > balance,
    };
  });
}
