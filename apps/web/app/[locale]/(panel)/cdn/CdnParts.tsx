import { StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { CdnRow, OriginKind } from "../../../../server/cdn-view.ts";

// Small pieces the CDN screens share. Synchronous, so they render in a test without a request.

const BADGE_OF: Record<CdnRow["state"], BadgeState> = {
  creating: "creating",
  active: "running",
  stopped: "stopped",
  suspended: "grace",
  destroyed: "retained",
  failed: "problem",
};

export function CdnState({ state }: { state: CdnRow["state"] }) {
  const t = useTranslations("Cdn.state");
  return <StateBadge state={BADGE_OF[state]} label={t(state)} />;
}

/** "Cloud Server: web-1"; the kind alone when the origin has no name; a word when it is gone. */
export function useOriginLabel(): (name: string | null, kind: OriginKind | null) => string {
  const t = useTranslations("Cdn.origin");
  return (name, kind) => {
    if (kind === null) return t("none");
    return name === null || name === "" ? t(kind) : `${t(kind)}: ${name}`;
  };
}
