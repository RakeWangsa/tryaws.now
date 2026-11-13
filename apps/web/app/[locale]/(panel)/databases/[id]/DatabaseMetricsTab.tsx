import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { METRIC_RANGE_KEYS } from "../../../../../server/extras-view.ts";
import type { MetricRangeKey } from "../../../../../server/extras-view.ts";
import type { DatabaseMetricsScreen } from "../../../../../server/reader-reads-view.ts";
import { MetricChart } from "../../servers/[id]/MetricsCharts.tsx";

// WPU-Y8. The Metrics tab of a database: four series with a 1 hour, 1 day and 1 week selector. The
// selector is a set of links (the page reads again on load; no timer, no script). The charts are the
// server-rendered SVG of the server Metrics tab, each with a text label and a note that says what one
// point means (average, highest or lowest of a period), so nothing is shown by a drawing alone (U11).

type Numerals = "beng" | "latn";

export function DatabaseMetricsTab({
  databaseId,
  screen,
  locale,
  numerals,
}: {
  databaseId: string;
  screen: DatabaseMetricsScreen;
  locale: Locale;
  numerals: Numerals;
}) {
  const t = useTranslations("Databases.detail.metrics");
  const range: MetricRangeKey = screen.state === "unavailable" ? "1h" : screen.range;
  const href = (key: MetricRangeKey) =>
    `${localePath(locale, `/databases/${encodeURIComponent(databaseId)}`)}?tab=metrics&range=${key}`;
  const minutes = new Intl.NumberFormat(`${locale === "bn" ? "bn-BD" : "en-BD"}-u-nu-${numerals}`);
  return (
    <>
      <nav className="d-flex flex-wrap gap-2 mb-3" aria-label={t("rangeLabel")}>
        {METRIC_RANGE_KEYS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={key === range ? "primary" : "default"}
            href={href(key)}
          >
            {t(`range.${key}`)}
          </Button>
        ))}
      </nav>
      {screen.state === "unavailable" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : screen.state === "empty" ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        screen.series.map((series) => (
          <div key={series.metric}>
            <MetricChart
              series={series}
              name={t(`series.${series.metric}`)}
              locale={locale}
              numerals={numerals}
              range={screen.range}
            />
            <p className="seccolor mb-3">
              {t(`note.${series.statistic}`, {
                minutes: minutes.format(Math.round(series.periodSeconds / 60)),
              })}
            </p>
          </div>
        ))
      )}
    </>
  );
}
