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
}

export type LifecycleAction =
  | { readonly type: "none" }
  | { readonly type: "remind"; readonly day: number }
  // Period end: renew when tryRenew (the engine then falls back to grace if the wallet is short).
  | { readonly type: "period_end"; readonly tryRenew: boolean }
  | { readonly type: "retry_renew" }
  | { readonly type: "retain" }
  | { readonly type: "ensure_retention_operations" }
  | { readonly type: "end" };

const NONE: LifecycleAction = { type: "none" };

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
      if (nowMs >= endMs) return { type: "period_end", tryRenew: view.autoRenew };
      // The smallest reminder day that is due: a late run sends one mail, not three.
      const due = [...config.reminderDays]
        .sort((a, b) => a - b)
        .find((day) => nowMs >= endMs - day * DAY_MS);
      return due === undefined ? NONE : { type: "remind", day: due };
    }

    case "grace": {
      if (nowMs >= endMs + config.graceHours * HOUR_MS) return { type: "retain" };
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
