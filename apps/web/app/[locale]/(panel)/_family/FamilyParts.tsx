import { StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { useTranslations } from "next-intl";

// Small pieces the database and load balancer screens share. Synchronous, so they render in a test
// without a request. `ns` is the message namespace of the family; both have the same `state` keys.

export type FamilyNamespace = "Databases" | "LoadBalancers" | "Dns";
export type ResourceState =
  "creating" | "active" | "stopped" | "suspended" | "destroyed" | "failed";

const BADGE_OF: Record<ResourceState, BadgeState> = {
  creating: "creating",
  active: "running",
  stopped: "stopped",
  suspended: "grace",
  destroyed: "retained",
  failed: "problem",
};

/** The state of a resource: a badge with a word, never colour alone (U11). */
export function FamilyState({ ns, state }: { ns: FamilyNamespace; state: ResourceState }) {
  const t = useTranslations(`${ns}.state`);
  return <StateBadge state={BADGE_OF[state]} label={t(state)} />;
}
