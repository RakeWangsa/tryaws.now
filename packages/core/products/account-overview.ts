// Pure logic of the account overview screens of the customer panel (WPU-G5): the first-use guide of
// the dashboard, the usage summary of the billing page and the grouping of the Snapshots page.
// No AWS, no HTTP, no database. Money is bigint paisa and is only added here (R4).

// ----- Onboarding ------------------------------------------------------------------------------

/** The steps of a first launch in the order a customer meets them. */
export const ONBOARDING_STEP_KEYS = [
  "phone",
  "kyc",
  "topUp",
  "sshKey",
  "server",
  "firewall",
  "snapshot",
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export interface OnboardingInput {
  phoneVerified: boolean;
  kycVerified: boolean;
  toppedUp: boolean;
  /** Public keys the customer has saved. */
  sshKeys: number;
  /** Live servers (Linux or Windows). */
  servers: number;
  /** At least one server has a firewall list that the customer saved. */
  firewallReviewed: boolean;
  /** Manual snapshots that exist now. */
  snapshots: number;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  /** The step needs a server first (firewall, snapshot). A locked step is never done. */
  locked: boolean;
}

export interface Onboarding {
  steps: OnboardingStep[];
  /** The first step that is open and not locked; null when all are done. */
  next: OnboardingStepKey | null;
  complete: boolean;
  /** The customer has at least one server: the guide then shows the follow-up steps only. */
  started: boolean;
}

const count = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

export function onboardingSteps(input: OnboardingInput): Onboarding {
  const hasServer = count(input.servers);
  const steps: OnboardingStep[] = [
    { key: "phone", done: input.phoneVerified, locked: false },
    { key: "kyc", done: input.kycVerified, locked: false },
    { key: "topUp", done: input.toppedUp, locked: false },
    { key: "sshKey", done: count(input.sshKeys), locked: false },
    { key: "server", done: hasServer, locked: false },
    { key: "firewall", done: hasServer && input.firewallReviewed, locked: !hasServer },
    { key: "snapshot", done: hasServer && count(input.snapshots), locked: !hasServer },
  ];
  const next = steps.find((s) => !s.done && !s.locked);
  return {
    steps,
    next: next?.key ?? null,
    complete: steps.every((s) => s.done),
    started: hasServer,
  };
}

// ----- Usage and billing -----------------------------------------------------------------------

export interface UsageInput {
  family: string;
  /** The subscription status; only `active` and `grace` are running charges. */
  status: string;
  /** The price of one term in paisa from the stored snapshot; null when it cannot be read. */
  amountMinor: bigint | null;
  periodEnd: Date;
  autoRenew: boolean;
}

export interface UsageFamily {
  family: string;
  count: number;
  totalMinor: bigint;
}

export interface UsageSummary {
  /** The price of one term of everything that runs now, in paisa. */
  totalMinor: bigint;
  running: number;
  /** Running resources whose price is not readable (they add nothing to the total). */
  unpriced: number;
  /** Running resources that will not renew by themselves. */
  autoRenewOff: number;
  nextRenewal: Date | null;
  families: UsageFamily[];
}

const RUNNING = ["active", "grace"];

export function usageSummary(rows: readonly UsageInput[]): UsageSummary {
  const byFamily = new Map<string, UsageFamily>();
  let total = 0n;
  let running = 0;
  let unpriced = 0;
  let autoRenewOff = 0;
  let next: Date | null = null;
  for (const row of rows) {
    if (!RUNNING.includes(row.status)) continue;
    running += 1;
    if (!row.autoRenew) autoRenewOff += 1;
    if (next === null || row.periodEnd.getTime() < next.getTime()) next = row.periodEnd;
    const slot = byFamily.get(row.family) ?? { family: row.family, count: 0, totalMinor: 0n };
    slot.count += 1;
    if (row.amountMinor === null || row.amountMinor < 0n) {
      unpriced += 1;
    } else {
      slot.totalMinor += row.amountMinor;
      total += row.amountMinor;
    }
    byFamily.set(row.family, slot);
  }
  return {
    totalMinor: total,
    running,
    unpriced,
    autoRenewOff,
    nextRenewal: next,
    families: [...byFamily.values()].sort((a, b) => (a.family < b.family ? -1 : 1)),
  };
}

// ----- Snapshots -------------------------------------------------------------------------------

export interface SnapshotInput {
  id: string;
  parentId: string | null;
  state: string;
  createdAt: Date;
  final: boolean;
}

export interface SnapshotGroup {
  parentId: string;
  /** Every snapshot of the server that is not destroyed, newest first. */
  items: SnapshotInput[];
  /** The snapshots a new server can be made from (state `active`), newest first. */
  restorable: SnapshotInput[];
  /** Manual snapshots; the final one belongs to the lifecycle and does not count. */
  manual: number;
  newest: Date;
}

const byNewest = (a: SnapshotInput, b: SnapshotInput): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1);

/** Groups snapshots by the server they were taken from; the group with the newest snapshot is first. */
export function groupSnapshots(rows: readonly SnapshotInput[]): SnapshotGroup[] {
  const groups = new Map<string, SnapshotInput[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = groups.get(row.parentId) ?? [];
    list.push(row);
    groups.set(row.parentId, list);
  }
  return [...groups.entries()]
    .map(([parentId, list]) => {
      const items = [...list].sort(byNewest);
      return {
        parentId,
        items,
        restorable: items.filter((i) => i.state === "active"),
        manual: items.filter((i) => !i.final && i.state !== "failed").length,
        newest: (items[0] as SnapshotInput).createdAt,
      };
    })
    .sort((a, b) => b.newest.getTime() - a.newest.getTime() || (a.parentId < b.parentId ? -1 : 1));
}
