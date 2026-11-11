import { useTranslations } from "next-intl";
import { Card } from "./Card";
import { DateText } from "./DateText";

export type TimelineState = "done" | "current" | "pending" | "failed";

export interface TimelineStep {
  id: string;
  label: string;
  state: TimelineState;
  at?: Date | string;
}

export interface StatusTimelineProps {
  label: string;
  steps: TimelineStep[];
}

/** Class and icon of each state. State is never shown by color alone (U11): icon and word too. */
const LOOK: Record<TimelineState, { item: string; icon: string }> = {
  done: { item: "tc-timeline-step tc-timeline-done", icon: "fas fa-check-circle" },
  current: { item: "tc-timeline-step tc-timeline-current", icon: "fas fa-dot-circle" },
  pending: { item: "tc-timeline-step tc-timeline-pending", icon: "far fa-circle" },
  failed: { item: "tc-timeline-step tc-timeline-failed", icon: "fas fa-times-circle" },
};

/** The steps of an order or of a provisioning job, in order. */
export function StatusTimeline({ label, steps }: StatusTimelineProps) {
  const t = useTranslations("kit.timeline");
  if (steps.filter((step) => step.state === "current").length > 1) {
    throw new RangeError("StatusTimeline: at most one step may be current");
  }
  return (
    <Card>
      <ol className="list-unstyled tc-timeline" aria-label={label}>
        {steps.map((step) => {
          const look = LOOK[step.state];
          return (
            <li
              key={step.id}
              className={look.item}
              aria-current={step.state === "current" ? "step" : undefined}
            >
              <i className={look.icon} aria-hidden="true" />
              <div>
                <span className="seccolor">{step.label}</span>
                <span className="visually-hidden">{t(step.state)}</span>
                {step.at !== undefined ? (
                  <DateText value={step.at} variant="datetime" className="d-block small c-grey" />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
