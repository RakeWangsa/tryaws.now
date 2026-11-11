import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "purple" | "grey" | "pink" | "dark";

export interface BadgeProps {
  tone: BadgeTone;
  /** The `feat` tag of a plan card. */
  feat?: boolean;
  className?: string;
  children?: ReactNode;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  purple: "bg-purple",
  grey: "bg-grey",
  pink: "bg-pink",
  dark: "bg-dark",
};

/** A plain tag of the theme. For the state of a resource use StateBadge. */
export function Badge({ tone, feat = false, className, children }: BadgeProps) {
  return (
    <span className={cx("badge", TONE_CLASS[tone], feat && "feat", className)}>{children}</span>
  );
}

export type BadgeState =
  | "creating"
  | "running"
  | "stopped"
  | "grace"
  | "retained"
  | "problem"
  | "paid"
  | "pending"
  | "failed";

/** Classes and icon of each state (16.13). State is never shown by color alone (U11). */
const STATE_LOOK: Record<BadgeState, { classes: string; icon: string }> = {
  creating: { classes: "badge bg-info text-dark", icon: "fas fa-spinner" },
  running: { classes: "badge bg-success", icon: "fas fa-check-circle" },
  stopped: { classes: "badge bg-secondary", icon: "fas fa-stop-circle" },
  grace: { classes: "badge bg-warning text-dark", icon: "fas fa-clock" },
  retained: { classes: "badge bg-grey", icon: "fas fa-archive" },
  problem: { classes: "badge bg-danger", icon: "fas fa-exclamation-triangle" },
  paid: { classes: "badge bg-success", icon: "fas fa-check" },
  pending: { classes: "badge bg-warning text-dark", icon: "fas fa-hourglass-half" },
  failed: { classes: "badge bg-secondary", icon: "fas fa-times-circle" },
};

export interface StateBadgeProps {
  state: BadgeState;
  /** Replaces the default label `kit.state.<state>`. */
  label?: string;
}

export function StateBadge({ state, label }: StateBadgeProps) {
  const t = useTranslations("kit.state");
  const look = STATE_LOOK[state];
  return (
    <span className={look.classes}>
      <i className={cx(look.icon, "me-1")} aria-hidden="true" />
      {label ?? t(state)}
    </span>
  );
}
