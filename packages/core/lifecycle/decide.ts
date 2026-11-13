import type { LifecycleConfig } from "./config";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type SubscriptionStatus = "active" | "grace" | "retained" | "ended";

// What the decision needs and nothing else: no id, no money, no customer data.
export interface DecisionView {
  readonly status: SubscriptionStatus;
  readonly periodEnd: Date;
  readonly autoRenew: boolean;
  readonly resourceState: string;
  // resources.deleted_at: the instant the destroy happened; the retention runs from it.
  readonly destroyedAt: Date | null;
  /**
   * WPU-Y9. When the grace started after a rate hold was released (the renewal could not be priced, so the days
   * of the hold are not the customer's). The grace runs from the later of this and the period end. Absent: from
   * the period end.
   */
  readonly graceFrom?: Date | null;
  /**
   * WPU-Y2. Days before the period end at which the renewal is charged (renewLeadDaysOf of the family: 30 for a
   * domain). Absent or 0: at the period end (section 11). The reminders lead the charge day.
   */
  readonly renewLeadDays?: number;
}

export type LifecycleAction =
  | { readonly type: "none" }
  | { readonly type: "remind"; readonly day: number }
  // Period end: renew when tryRenew (the engine then falls back to grace if the wallet is short).
  | { readonly type: "period_end"; readonly tryRenew: boolean }
  // WPU-Y2: inside the lead time before the period end, auto-renew on: charge now; a short wallet only retries.
  | { readonly type: "early_renew" }
  | { readonly type: "retry_renew" }
  | { readonly type: "retain" }
  | { readonly type: "ensure_retention_operations" }
  | { readonly type: "end" };

const NONE: LifecycleAction = { type: "none" };
/** A lead time longer than a year is no lead time (R16). */
const MAX_LEAD_DAYS = 365;

// Resource states in which a customer resource still lives and a period can run out.
const LIVE_STATES = ["active", "stopped", "suspended"] as const;

// Pure: the table of section 11 as one function of (state, clock). R16: a clock that is not a
// date, or a resource that is not in a state the table knows, decides nothing.
export function decideSubscription(
  view: DecisionView,
  now: Date,
  config: LifecycleConfig,
): LifecycleAction {
  const nowMs = now.getTime();
  const endMs = view.periodEnd.getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(endMs)) return NONE;

  switch (view.status) {
    case "ended":
      return NONE;

    case "active": {
      if (!(LIVE_STATES as readonly string[]).includes(view.resourceState)) return NONE;
      const lead = view.renewLeadDays ?? 0;
      if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS) return NONE;
      if (nowMs >= endMs) return { type: "period_end", tryRenew: view.autoRenew };
      // WPU-Y2: the charge day is the lead time before the period end.
      const chargeMs = endMs - lead * DAY_MS;
      if (lead > 0 && view.autoRenew && nowMs >= chargeMs) return { type: "early_renew" };
      // The smallest reminder day that is due: a late run sends one mail, not three.
      const due = [...config.reminderDays]
        .sort((a, b) => a - b)
        .find((day) => nowMs >= chargeMs - day * DAY_MS);
      return due === undefined ? NONE : { type: "remind", day: due };
    }

    case "grace": {
      const fromMs = view.graceFrom?.getTime();
      const graceStart =
        fromMs !== undefined && !Number.isNaN(fromMs) && fromMs > endMs ? fromMs : endMs;
      if (nowMs >= graceStart + config.graceHours * HOUR_MS) return { type: "retain" };
      return view.autoRenew ? { type: "retry_renew" } : NONE;
    }

    case "retained": {
      if (view.resourceState !== "destroyed") return { type: "ensure_retention_operations" };
      if (view.destroyedAt === null) return NONE;
      const destroyedMs = view.destroyedAt.getTime();
      if (Number.isNaN(destroyedMs)) return NONE;
      return nowMs >= destroyedMs + config.retentionDays * DAY_MS ? { type: "end" } : NONE;
    }
  }
}
