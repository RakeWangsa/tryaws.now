import type { CustomerSession } from "@tc/auth";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  DISK_ANCHOR_AWS_ID,
  MAX_DISK_GB,
  MIN_DISK_GB,
  onboardingSteps,
  priceCatalog,
  readLifecycleConfig,
} from "@tc/core";
import type { Onboarding } from "@tc/core";
import {
  customerRepos,
  listCatalogProducts,
  readCatalogProduct,
  readFeatureFlag,
  withTx,
} from "@tc/db";
import type { CatalogProduct, InvoiceRow, NotificationRow, SubscriptionRow } from "@tc/db";
import { TEMPLATE_IDS, parseTemplateData, renderInApp } from "@tc/notify";
import type { RenderContext, TemplateId } from "@tc/notify";
import { resourceFacts } from "./extras-actions.ts";
import { planSpecsOf, serverConfigOf } from "./servers-view.ts";
import type { PlanOption } from "./servers-view.ts";

// What the server tabs Backups, Storage, Billing and Destroy, the dashboard and /notifications show,
// read through the repositories of the session's customer only (R8). A database error is thrown,
// never answered with an empty list (R16). Nothing here returns an AWS account id, an ARN, a
// generated AWS name or an error text of AWS (U6, R11): resource configs are read field by field.

const FAMILY = "linux_instance";
export const DAY_MS = 86_400_000;
export const RENEWAL_WINDOW_DAYS = 7;
const LIVE = ["active", "stopped", "suspended"];

export interface PriceLines {
  baseMinor: bigint;
  steps: { code: string; amountMinor: bigint }[];
  totalMinor: bigint;
}

const MINOR = /^\d{1,18}$/;

/** The stored pricing snapshot as bigint paisa; null when it is not exactly the stored shape (R4, R16). */
export function parsePriceLines(snapshot: unknown): PriceLines | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const raw = snapshot as Record<string, unknown>;
  const base = raw["baseMinor"];
  const total = raw["totalMinor"];
  const steps = raw["steps"];
  if (typeof base !== "string" || !MINOR.test(base)) return null;
  if (typeof total !== "string" || !MINOR.test(total)) return null;
  if (!Array.isArray(steps)) return null;
  const out: PriceLines["steps"] = [];
  let sum = BigInt(base);
  for (const step of steps as unknown[]) {
    const s = typeof step === "object" && step !== null ? (step as Record<string, unknown>) : {};
    if (typeof s["code"] !== "string" || typeof s["amountMinor"] !== "string") return null;
    if (!/^-?\d{1,18}$/.test(s["amountMinor"])) return null;
    const amount = BigInt(s["amountMinor"]);
    out.push({ code: s["code"].slice(0, 40), amountMinor: amount });
    sum += amount;
  }
  // A breakdown that does not add up is not shown (R16).
  if (sum !== BigInt(total)) return null;
  return { baseMinor: BigInt(base), steps: out, totalMinor: BigInt(total) };
}

/** What the add-disk form needs: the anchor row of the server's Region and the size limits. */
export interface DiskOffer {
  productId: string;
  minGb: number;
  maxGb: number;
}

/**
 * The offer to add a disk for this server: only behind the flag `disk` (R12), only for a live server,
 * and only from the active anchor row of the server's own Region, priced per GB-month. Anything else
 * is no offer, and the tab shows the form switched off (R16). The price is shown on the review page.
 */
export function diskOfferFor(input: {
  rows: readonly CatalogProduct[];
  region: string | null;
  flagOn: boolean;
  live: boolean;
}): DiskOffer | null {
  if (!input.flagOn || !input.live || input.region === null) return null;
  const row = input.rows.find(
    (r) =>
      r.family === "disk" &&
      r.awsId === DISK_ANCHOR_AWS_ID &&
      r.active &&
      r.region === input.region &&
      r.billingUnit === "gb_month",
  );
  return row === undefined ? null : { productId: row.id, minGb: MIN_DISK_GB, maxGb: MAX_DISK_GB };
}

export interface BackupItem {
  id: string;
  name: string;
  sizeGb: number | null;
  createdAt: Date;
  state: string;
  final: boolean;
}
export interface DiskItem {
  id: string;
  name: string;
  sizeGb: number | null;
  region: string | null;
  state: string;
  attachedToThis: boolean;
  attachedElsewhere: boolean;
}
export interface InvoiceItem {
  id: string;
  fiscalYear: number;
  number: number;
  totalMinor: bigint;
  issuedAt: Date;
}

export interface ServerExtras {
  id: string;
  name: string;
  /** The Region of the server; a restore stays in it. */
  region: string | null;
  state: string;
  live: boolean;
  autoBackup: { enabled: boolean; hour: string | null };
  backups: BackupItem[];
  canBackup: boolean;
  disks: DiskItem[];
  /** Disks of the customer in the same Region that no server holds (the ones that can be attached). */
  freeDisks: DiskItem[];
  /** addDisk: null = the form is shown switched off (flag off, server not live, no row for the Region). */
  diskOffer: DiskOffer | null;
  billing: {
    status: SubscriptionRow["status"] | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    autoRenew: boolean;
    lines: PriceLines | null;
    invoices: InvoiceItem[];
  };
  destroy: {
    allowed: boolean;
    manualBackups: number;
    /** Days the final backup is kept: the lifecycle setting of the market (WPU-B6), 14 until set. */
    retentionDays: number;
  };
  /**
   * restoreToNewServer: the plans of this server's Region whose disk is not smaller than the disk
   * of this server's plan, priced for the customer. Empty when nothing can be offered (R16).
   */
  restorePlans: PlanOption[];
  /** The id of the request, put in every form of the tabs (R7). */
  requestId: string;
}

export type ExtrasScreen = { state: "flag_off" } | { state: "ready"; extras: ServerExtras | null };

function autoBackupOf(config: unknown): ServerExtras["autoBackup"] {
  const c =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const a =
    typeof c["autoBackup"] === "object" && c["autoBackup"] !== null
      ? (c["autoBackup"] as Record<string, unknown>)
      : {};
  const hour = a["hour"];
  return {
    enabled: a["enabled"] === true,
    hour: typeof hour === "string" && /^([01]\d|2[0-3]):00$/.test(hour) ? hour : null,
  };
}

const toInvoice = (row: InvoiceRow): InvoiceItem => ({
  id: row.id,
  fiscalYear: row.fiscalYear,
  number: row.number,
  totalMinor: row.totalMinor,
  issuedAt: row.issuedAt,
});

/**
 * The plans a backup of this server can be restored to: Linux plans of the same Region with a disk
 * that is not smaller (Lightsail refuses a smaller one). Priced with the rate and rule in force; if
 * that is not possible or the disk size of this server's plan is unknown, nothing is offered.
 */
export async function restorePlansFor(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  market: string,
  server: { productId: string | null; region: string | null },
  now: () => Date,
): Promise<PlanOption[]> {
  if (server.productId === null || server.region === null) return [];
  const own = await readCatalogProduct(tx, server.productId);
  const minDisk = planSpecsOf(own?.specs).diskGb;
  if (minDisk === undefined || minDisk <= 0) return [];
  const rows = (await listCatalogProducts(tx, FAMILY)).filter((row) => {
    const disk = planSpecsOf(row.specs).diskGb;
    return (
      row.platform === "linux" &&
      row.region === server.region &&
      disk !== undefined &&
      disk >= minDisk
    );
  });
  const priced = await priceCatalog(tx, rows, { market }, { now });
  if (!priced.ok) return [];
  return priced.value.map((row) => ({
    id: row.id,
    region: row.region,
    priceMinor: row.priceBdt.totalMinor,
    specs: planSpecsOf(row.specs),
  }));
}

/** The customer saved a firewall list of their own on this server (WPU-G2 stores it in the config). */
function hasSavedFirewall(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    Array.isArray((config as Record<string, unknown>)["firewallRules"])
  );
}

/** null extras = the server is missing or another customer's (R8). */
export async function loadServerExtras(
  session: CustomerSession,
  id: string,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<ExtrasScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("extras: no customer row");
    if ((await readFeatureFlag(tx, FAMILY, profile.market)) !== true) return { state: "flag_off" };
    const server = await repos.resources.get(id);
    if (server === null || server.family !== FAMILY) return { state: "ready", extras: null };

    const [children, disks, subscription, invoices] = await Promise.all([
      repos.resources.listChildren(id, "backup"),
      repos.resources.list(),
      repos.subscriptions.get(id),
      repos.invoices.list({ limit: 5 }),
    ]);
    const backups = children.map((b): BackupItem => {
      const f = resourceFacts(b);
      return {
        id: b.id,
        name: f.name,
        sizeGb: f.sizeGb,
        createdAt: b.createdAt,
        state: b.state,
        final: f.final,
      };
    });
    const diskItems = disks
      .filter((r) => r.family === "disk" && r.state !== "destroyed" && r.state !== "failed")
      .map((r): DiskItem => {
        const f = resourceFacts(r);
        return {
          id: r.id,
          name: f.name,
          sizeGb: f.sizeGb,
          region: r.region,
          state: r.state,
          attachedToThis: f.attachedTo === id,
          attachedElsewhere: f.attachedTo !== null && f.attachedTo !== id,
        };
      });
    const live = LIVE.includes(server.state);
    const diskOffer = diskOfferFor({
      rows: await listCatalogProducts(tx, "disk"),
      region: server.region,
      flagOn: (await readFeatureFlag(tx, "disk", profile.market)) === true,
      live: server.state === "active" || server.state === "stopped",
    });
    const restorePlans = live ? await restorePlansFor(tx, profile.market, server, now) : [];
    const manualBackups = backups.filter((b) => !b.final).length;
    // The text must not say a number that the engine does not use: the setting, or the default of the
    // engine when it cannot be read (the engine itself fails closed on a bad row).
    const retentionDays = await readLifecycleConfig(tx)
      .then((c) => c.retentionDays)
      .catch(() => DEFAULT_LIFECYCLE_CONFIG.retentionDays);
    return {
      state: "ready",
      extras: {
        id: server.id,
        region: server.region,
        name: serverConfigOf(server.config).displayName,
        state: server.state,
        live,
        autoBackup: autoBackupOf(server.config),
        backups,
        canBackup: live,
        disks: diskItems.filter((d) => d.attachedToThis),
        freeDisks: diskItems.filter(
          (d) =>
            !d.attachedToThis &&
            !d.attachedElsewhere &&
            d.state === "active" &&
            d.region === server.region,
        ),
        diskOffer,
        billing: {
          status: subscription?.status ?? null,
          periodStart: subscription?.periodStart ?? null,
          periodEnd: subscription?.periodEnd ?? null,
          autoRenew: subscription?.autoRenew ?? false,
          lines: subscription === null ? null : parsePriceLines(subscription.priceSnapshot),
          invoices: invoices.items.map(toInvoice),
        },
        restorePlans,
        destroy: {
          allowed:
            live &&
            subscription !== null &&
            (subscription.status === "active" || subscription.status === "grace"),
          manualBackups,
          retentionDays,
        },
        requestId,
      },
    };
  });
}

// ----- Metrics ---------------------------------------------------------------------------------

export type MetricRangeKey = "1h" | "1d" | "1w";
export const METRIC_RANGE_KEYS: readonly MetricRangeKey[] = ["1h", "1d", "1w"];

export interface MetricSeriesView {
  metric: "cpu" | "networkIn" | "networkOut" | "statusCheckFailed";
  unit: "percent" | "bytes" | "count";
  points: { at: string; value: number }[];
}

/**
 * The live read of the `reader` function (WP5-T3), checked by the reader itself against the caller.
 * The web tier has no AWS client (R1): the binding is an invocation of that function, supplied at
 * start-up. null = not configured, and the tab says that metrics are not available (R16).
 */
export interface ReaderPort {
  metrics(
    resourceId: string,
    caller: { customerId: string },
    range: MetricRangeKey,
  ): Promise<{ ok: true; series: readonly MetricSeriesView[] } | { ok: false; error: string }>;
}

export type MetricsScreen =
  | { state: "unavailable" }
  | { state: "empty"; range: MetricRangeKey }
  | { state: "ready"; range: MetricRangeKey; series: MetricSeriesView[] };

export function rangeOf(value: unknown): MetricRangeKey {
  return METRIC_RANGE_KEYS.find((r) => r === value) ?? "1h";
}

/** The ownership is checked here on the session's repositories and again by the reader (R8). */
export async function loadMetrics(
  session: CustomerSession,
  id: string,
  range: MetricRangeKey,
  reader: ReaderPort | null,
): Promise<MetricsScreen> {
  if (reader === null) return { state: "unavailable" };
  const owned = await withTx(async (tx) => {
    const row = await customerRepos(tx, session.customerId).resources.get(id);
    return row !== null && row.family === FAMILY && LIVE.includes(row.state);
  });
  if (!owned) return { state: "empty", range };
  try {
    const result = await reader.metrics(id, { customerId: session.customerId }, range);
    if (!result.ok) return { state: "unavailable" };
    const series = result.series.filter((s) => s.points.length > 0).map((s) => ({ ...s }));
    return series.length === 0 ? { state: "empty", range } : { state: "ready", range, series };
  } catch {
    // Never the text of the failure (U6): the tab shows its own unavailable state.
    return { state: "unavailable" };
  }
}

// ----- Dashboard -------------------------------------------------------------------------------

export interface DashboardView {
  state: "ready";
  balanceMinor: bigint;
  families: { family: string; count: number }[];
  renewals: { resourceId: string; name: string; periodEnd: Date; amountMinor: bigint | null }[];
  alerts: {
    kycPending: boolean;
    lowBalance: boolean;
    inGrace: { resourceId: string; name: string }[];
  };
  operations: { id: string; kind: string; state: string; name: string; createdAt: Date }[];
  /** WPU-G5: the first-use guide (phone, KYC, top-up, key, first server, firewall, snapshot). */
  onboarding: Onboarding;
  /** The server the follow-up steps (firewall, snapshot) point to: the oldest live server. */
  guideServerId: string | null;
}
export type DashboardScreen = DashboardView;

export async function loadDashboard(session: CustomerSession, now: Date): Promise<DashboardView> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [profile, wallet, resources, subs, ops, payments, keys] = await Promise.all([
      repos.profile.get(),
      repos.wallet.view(),
      repos.resources.list(),
      repos.subscriptions.list(),
      repos.operations.listRecent(5),
      repos.payments.list(1),
      repos.sshKeys.list(),
    ]);
    if (profile === null) throw new Error("dashboard: no customer row");
    const balance = wallet?.balanceMinor ?? 0n;
    const nameOf = new Map(
      resources.map((r) => [r.id, serverConfigOf(r.config).displayName || resourceFacts(r).name]),
    );
    const live = resources.filter((r) => r.state !== "destroyed" && r.state !== "failed");
    const counts = new Map<string, number>();
    for (const r of live) counts.set(r.family, (counts.get(r.family) ?? 0) + 1);

    const horizon = now.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS;
    const due = subs.filter(
      (s) =>
        s.status === "active" &&
        s.periodEnd.getTime() >= now.getTime() &&
        s.periodEnd.getTime() <= horizon,
    );
    const renewals = due.map((s) => ({
      resourceId: s.resourceId,
      name: nameOf.get(s.resourceId) ?? "",
      periodEnd: s.periodEnd,
      amountMinor: parsePriceLines(s.priceSnapshot)?.totalMinor ?? null,
    }));
    const dueTotal = renewals.reduce((sum, r) => sum + (r.amountMinor ?? 0n), 0n);
    const phoneVerified = profile.phoneVerifiedAt !== null;
    const servers = live.filter((r) => r.family === FAMILY || r.family === "windows_instance");
    return {
      state: "ready",
      balanceMinor: balance,
      families: [...counts].map(([family, count]) => ({ family, count })),
      renewals,
      alerts: {
        kycPending: profile.kycStatus !== "verified",
        lowBalance: dueTotal > balance,
        inGrace: subs
          .filter((s) => s.status === "grace")
          .map((s) => ({ resourceId: s.resourceId, name: nameOf.get(s.resourceId) ?? "" })),
      },
      operations: ops.map((o) => ({
        id: o.id,
        kind: o.kind,
        state: o.state,
        name: nameOf.get(o.resourceId) ?? "",
        createdAt: o.createdAt,
      })),
      onboarding: onboardingSteps({
        phoneVerified,
        kycVerified: profile.kycStatus === "verified",
        toppedUp: payments.length > 0 || balance > 0n,
        sshKeys: keys.length,
        servers: servers.length,
        firewallReviewed: servers.some((r) => hasSavedFirewall(r.config)),
        snapshots: live.filter((r) => r.family === "backup" && !resourceFacts(r).final).length,
      }),
      // list() is newest first, so the last live server is the oldest one.
      guideServerId:
        servers.length === 0 ? null : (servers[servers.length - 1] as { id: string }).id,
    };
  });
}

// ----- Notifications ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  read: boolean;
  createdAt: Date;
  /** The rendered words of the template in the viewer's locale (packages/notify), or null. */
  title: string | null;
  body: string | null;
  /** A path of this panel, never another origin. */
  href: string | null;
}

/** The bell item is rendered when it is shown, in the viewer's locale (packages/notify). */
export function toNotificationItem(row: NotificationRow, ctx: RenderContext): NotificationItem {
  const base = { id: row.id, read: row.readAt !== null, createdAt: row.createdAt };
  try {
    const id = TEMPLATE_IDS.find((candidate) => candidate === row.template);
    if (id === undefined) throw new Error("unknown");
    const data = parseTemplateData(id satisfies TemplateId, row.payload);
    const out = renderInApp(id, data, ctx);
    const url = new URL(out.href);
    const local = url.origin === new URL(ctx.panelOrigin).origin;
    return {
      ...base,
      title: out.title,
      body: out.body,
      href: local ? `${url.pathname}${url.search}` : null,
    };
  } catch {
    // A row that cannot be rendered shows the generic line of the screen, never its payload (R14).
    return { ...base, title: null, body: null, href: null };
  }
}

export interface NotificationsScreen {
  items: NotificationItem[];
  unread: number;
}

export async function loadNotifications(
  session: CustomerSession,
  ctx: RenderContext,
): Promise<NotificationsScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [rows, unread] = await Promise.all([
      repos.notifications.list(),
      repos.notifications.unreadCount(),
    ]);
    return { items: rows.map((row) => toNotificationItem(row, ctx)), unread };
  });
}
