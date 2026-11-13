import { DataTable, EmptyState, StatTile, StateBadge, formatDate } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { TARGET_HEALTH_WORDS } from "../../../../../server/extras-view.ts";
import type { TargetHealthWord } from "../../../../../server/extras-view.ts";
import type { TargetHealthScreen } from "../../../../../server/reader-reads-view.ts";

// WPU-Y8. The health of the servers behind a load balancer, read once when the page loads (no timer, no
// polling). Servers are listed the way the Target servers tab lists them: by the name the customer gave,
// with the state as a word and a badge, never by color alone (U11). The text of every reason is a
// platform message; nothing of AWS reaches this markup (U6, R11).

type Numerals = "beng" | "latn";

const BADGE: Record<TargetHealthWord, BadgeState> = {
  healthy: "running",
  unhealthy: "problem",
  initial: "pending",
  unused: "stopped",
  draining: "pending",
  unavailable: "stopped",
};

export function TargetHealthPanel({
  screen,
  locale,
  numerals,
}: {
  screen: TargetHealthScreen;
  locale: Locale;
  numerals: Numerals;
}) {
  const t = useTranslations("LoadBalancers.detail.health");
  const none = useTranslations("LoadBalancers")("list.none");
  if (screen.state === "unavailable") {
    return <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />;
  }
  if (screen.state === "not_live") {
    return <EmptyState title={t("notLive.title")} description={t("notLive.body")} />;
  }
  if (screen.state === "empty") {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  const count = new Intl.NumberFormat(`${locale === "bn" ? "bn-BD" : "en-BD"}-u-nu-${numerals}`);
  return (
    <>
      <p className="seccolor" role="status">
        {t("checkedAt", {
          time: formatDate(screen.checkedAt, { locale, variant: "time", numerals }),
        })}
      </p>
      <div className="row g-3 mb-3">
        {TARGET_HEALTH_WORDS.map((word) => (
          <div key={word} className="col-6 col-md-4">
            <StatTile value={count.format(screen.counts[word])} description={t(`state.${word}`)} />
          </div>
        ))}
      </div>
      {screen.rows.length === 0 ? null : (
        <DataTable
          caption={t("caption")}
          rows={screen.rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "name",
              header: t("server"),
              cell: (row) => (row.name === "" ? none : row.name),
            },
            {
              key: "state",
              header: t("status"),
              cell: (row) => (
                <StateBadge state={BADGE[row.health]} label={t(`state.${row.health}`)} />
              ),
            },
            {
              key: "reason",
              header: t("reasonHeader"),
              cell: (row) => (row.reason === null ? none : t(`reason.${row.reason}`)),
            },
          ]}
        />
      )}
      {screen.unresolved === 0 ? null : (
        <p className="seccolor mt-3">
          {t("unresolved", { count: count.format(screen.unresolved) })}
        </p>
      )}
    </>
  );
}
