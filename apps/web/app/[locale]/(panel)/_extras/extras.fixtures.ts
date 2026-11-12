import type {
  DashboardView,
  MetricsScreen,
  NotificationsScreen,
  ServerExtras,
} from "../../../../server/extras-view.ts";
import type { ExtrasActions, ExtrasBundle } from "../servers/[id]/ExtrasTabs.tsx";

// Rows for the render tests of the screens of WP5-T6 (never imported by a page).

export const SERVER_ID = "0190aaaa-0000-7000-8000-0000000000a1";
export const DISK_ID = "0190aaaa-0000-7000-8000-0000000000a2";
export const FREE_DISK_ID = "0190aaaa-0000-7000-8000-0000000000a4";
export const BACKUP_ID = "0190aaaa-0000-7000-8000-0000000000a3";
export const FINAL_ID = "0190aaaa-0000-7000-8000-0000000000a5";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";

const noop = async () => ({});

export const noopActions: ExtrasActions = {
  createBackup: noop,
  deleteBackup: noop,
  setAutoBackup: noop,
  attachDisk: noop,
  detachDisk: noop,
  destroyDisk: noop,
  setAutoRenew: noop,
  renewNow: noop,
  restoreToNewServer: noop,
  destroyServer: noop,
};

export function extras(over: Partial<ServerExtras> = {}): ServerExtras {
  return {
    id: SERVER_ID,
    name: "web-1",
    region: "ap-south-1",
    state: "active",
    live: true,
    autoBackup: { enabled: true, hour: "03:00" },
    backups: [
      {
        id: BACKUP_ID,
        name: "before-upgrade",
        sizeGb: 20,
        createdAt: new Date("2026-11-11T06:00:00Z"),
        state: "active",
        final: false,
      },
      {
        id: FINAL_ID,
        name: "",
        sizeGb: 20,
        createdAt: new Date("2026-11-10T06:00:00Z"),
        state: "active",
        final: true,
      },
    ],
    canBackup: true,
    disks: [
      {
        id: DISK_ID,
        name: "data",
        sizeGb: 64,
        region: "ap-south-1",
        state: "active",
        attachedToThis: true,
        attachedElsewhere: false,
      },
    ],
    freeDisks: [
      {
        id: FREE_DISK_ID,
        name: "spare",
        sizeGb: 32,
        region: "ap-south-1",
        state: "active",
        attachedToThis: false,
        attachedElsewhere: false,
      },
    ],
    billing: {
      status: "active",
      periodStart: new Date("2026-11-01T00:00:00Z"),
      periodEnd: new Date("2026-12-01T00:00:00Z"),
      autoRenew: true,
      lines: {
        baseMinor: 60000n,
        steps: [{ code: "bd_vat", amountMinor: 9000n }],
        totalMinor: 69000n,
      },
      invoices: [
        {
          id: "0190aaaa-0000-7000-8000-0000000000e1",
          fiscalYear: 2026,
          number: 12,
          totalMinor: 69000n,
          issuedAt: new Date("2026-11-01T00:00:00Z"),
        },
      ],
    },
    restorePlans: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000d1",
        region: "ap-south-1",
        priceMinor: 69000n,
        specs: { vcpus: 1, ramGb: "1", diskGb: 40, transferGb: 2000 },
      },
    ],
    destroy: { allowed: true, manualBackups: 1 },
    requestId: REQUEST_ID,
    ...over,
  };
}

export const metricsReady: MetricsScreen = {
  state: "ready",
  range: "1h",
  series: [
    {
      metric: "cpu",
      unit: "percent",
      points: [
        { at: "2026-11-12T01:00:00Z", value: 12 },
        { at: "2026-11-12T01:05:00Z", value: 40 },
        { at: "2026-11-12T01:10:00Z", value: 25 },
      ],
    },
    {
      metric: "networkIn",
      unit: "bytes",
      points: [
        { at: "2026-11-12T01:00:00Z", value: 1000 },
        { at: "2026-11-12T01:05:00Z", value: 5000 },
      ],
    },
  ],
};

export function bundle(
  over: { data?: Partial<ServerExtras>; metrics?: MetricsScreen } = {},
): ExtrasBundle {
  return {
    data: extras(over.data),
    metrics: over.metrics ?? metricsReady,
    actions: noopActions,
  };
}

export function dashboard(over: Partial<DashboardView> = {}): DashboardView {
  return {
    state: "ready",
    balanceMinor: 150000n,
    families: [
      { family: "linux_instance", count: 2 },
      { family: "disk", count: 1 },
    ],
    renewals: [
      {
        resourceId: SERVER_ID,
        name: "web-1",
        periodEnd: new Date("2026-11-15T00:00:00Z"),
        amountMinor: 69000n,
      },
    ],
    alerts: {
      kycPending: true,
      lowBalance: false,
      inGrace: [{ resourceId: FREE_DISK_ID, name: "spare" }],
    },
    operations: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000b1",
        kind: "create_backup",
        state: "succeeded",
        name: "web-1",
        createdAt: new Date("2026-11-12T01:00:00Z"),
      },
      {
        id: "0190aaaa-0000-7000-8000-0000000000b2",
        kind: "destroy",
        state: "needs_approval",
        name: "old",
        createdAt: new Date("2026-11-12T02:00:00Z"),
      },
    ],
    checklist: { phone: true, kyc: false, topUp: true, server: true },
    ...over,
  };
}

export const emptyDashboard = dashboard({
  balanceMinor: 0n,
  families: [],
  renewals: [],
  operations: [],
  alerts: { kycPending: false, lowBalance: false, inGrace: [] },
  checklist: { phone: false, kyc: false, topUp: false, server: false },
});

export function notifications(over: Partial<NotificationsScreen> = {}): NotificationsScreen {
  return {
    unread: 1,
    items: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000c1",
        read: false,
        createdAt: new Date("2026-11-12T03:00:00Z"),
        title: "Your renewal is due",
        body: "Server web-1 renews soon.",
        href: "/bn/servers",
      },
      {
        id: "0190aaaa-0000-7000-8000-0000000000c2",
        read: true,
        createdAt: new Date("2026-11-11T03:00:00Z"),
        title: null,
        body: null,
        href: null,
      },
    ],
    ...over,
  };
}
