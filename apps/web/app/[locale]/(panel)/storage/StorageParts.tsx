import { StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { BucketRow } from "../../../../server/bucket-view.ts";

// Small pieces the object storage screens share. Synchronous, so they render in a test without a request.

const BADGE_OF: Record<BucketRow["state"], BadgeState> = {
  creating: "creating",
  active: "running",
  stopped: "stopped",
  suspended: "grace",
  destroyed: "retained",
  failed: "problem",
};

export function BucketState({ state }: { state: BucketRow["state"] }) {
  const t = useTranslations("Storage.state");
  return <StateBadge state={BADGE_OF[state]} label={t(state)} />;
}

/** "Asia Pacific (Singapore)"; the code itself for a Region this panel has no name for. */
export function useRegionLabel(): (region: string | null) => string {
  const t = useTranslations("Servers.region");
  const none = useTranslations("Storage.list")("none");
  return (region) => {
    if (region === null) return none;
    return t.has(region) ? t(region) : region;
  };
}
