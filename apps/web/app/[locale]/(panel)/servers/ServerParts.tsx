import { StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { PlanSpecs, ServerRow } from "../../../../server/servers-view.ts";

// Small pieces the server screens share. Synchronous, so they render in a test without a request.

const BADGE_OF: Record<ServerRow["state"], BadgeState> = {
  creating: "creating",
  active: "running",
  stopped: "stopped",
  suspended: "grace",
  destroyed: "retained",
  failed: "problem",
};

export function ServerState({ state }: { state: ServerRow["state"] }) {
  const t = useTranslations("Servers.state");
  return <StateBadge state={BADGE_OF[state]} label={t(state)} />;
}

/** "2 vCPU · 0.5 GB RAM · 20 GB disk": sizes only, from the catalog. */
export function useSpecLine(): (specs: PlanSpecs) => string {
  const t = useTranslations("Servers.spec");
  return (specs) => {
    const parts: string[] = [];
    if (specs.vcpus !== undefined) parts.push(t("vcpus", { count: specs.vcpus }));
    if (specs.ramGb !== undefined) parts.push(t("ram", { size: specs.ramGb }));
    if (specs.diskGb !== undefined) parts.push(t("disk", { size: specs.diskGb }));
    if (specs.transferGb !== undefined) parts.push(t("transfer", { size: specs.transferGb }));
    return parts.join(" · ");
  };
}

/** "Asia Pacific (Mumbai) · ap-south-1"; an unknown Region is shown by its code alone. */
export function useRegionLabel(): (region: string | null) => string {
  const t = useTranslations("Servers.region");
  return (region) => {
    if (region === null) return "—";
    return t.has(region) ? `${t(region)} · ${region}` : region;
  };
}
