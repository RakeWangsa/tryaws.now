import { Card, StateBadge, formatDate } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { MetricRangeKey, MetricSeriesView } from "../../../../../server/extras-view.ts";
import { bytesScale, buildChart, statusOf } from "../../../../../server/metric-chart.ts";

// WPU-G4: the charts of the Metrics tab as the console draws them: a time axis, a value axis with its
// unit, an area under the line. Server-rendered SVG with attributes and classes only: no chart library
// (U2, U3), no script and no style attribute (U4). The geometry is pure (server/metric-chart.ts). The
// state of the status checks is a word and a badge, never colour alone (U11). Times are in Dhaka time
// (16.13) and digits follow the panel's numerals.

type Numerals = "beng" | "latn";

const STATUS_BADGE: Record<ReturnType<typeof statusOf>, BadgeState> = {
  ok: "running",
  recovered: "pending",
  failed: "problem",
  unknown: "stopped",
};

function numberFormat(locale: Locale, numerals: Numerals, digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat(`${locale === "bn" ? "bn-BD" : "en-BD"}-u-nu-${numerals}`, {
    maximumFractionDigits: digits,
  });
}

export function MetricChart({
  series,
  name,
  locale,
  numerals,
  range,
}: {
  series: MetricSeriesView;
  name: string;
  locale: Locale;
  numerals: Numerals;
  range: MetricRangeKey;
}) {
  const t = useTranslations("Extras.metrics");
  const chart = buildChart(series);
  if (chart === null) {
    return (
      <Card className="mb-3">
        <h3 className="mergecolor h5">{name}</h3>
        <p className="seccolor mb-0">{t("noPoints")}</p>
      </Card>
    );
  }
  const isBytes = series.unit === "bytes";
  const scale = isBytes ? bytesScale(chart.max) : { unit: null, divisor: 1 };
  const unitText =
    isBytes && scale.unit !== null ? t(`bytesUnit.${scale.unit}`) : t(`unit.${series.unit}`);
  const axis = numberFormat(locale, numerals, 1);
  const axisText = (value: number): string => axis.format(value / scale.divisor);
  const latest = `${axis.format(chart.last / scale.divisor)} ${unitText}`;
  const timeVariant = range === "1w" ? "date" : "time";
  const at = (iso: string): string => formatDate(iso, { locale, variant: timeVariant, numerals });
  const status = series.metric === "statusCheckFailed" ? statusOf(series) : null;
  const label = t("chart", { name, count: chart.dots.length });
  const { plot } = chart;
  return (
    <Card className="mb-3">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <h3 className="mergecolor h5 mb-0">{name}</h3>
        {status === null ? null : (
          <StateBadge state={STATUS_BADGE[status]} label={t(`status.${status}`)} />
        )}
      </div>
      <p className="seccolor mb-2">{t("latest", { value: latest })}</p>
      <svg
        className="w-100 mergecolor"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <g className="seccolor" fill="currentColor" fontSize="11">
          {chart.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                strokeOpacity="0.25"
              />
              <text x={plot.left - 6} y={tick.y + 4} textAnchor="end">
                {axisText(tick.value)}
              </text>
            </g>
          ))}
          <text x={plot.left - 6} y={plot.top - 2} textAnchor="end">
            {unitText}
          </text>
          {chart.xTicks.map((tick, i) => (
            <text
              key={tick.at + String(i)}
              x={tick.x}
              y={plot.bottom + 18}
              textAnchor={i === 0 ? "start" : i === chart.xTicks.length - 1 ? "end" : "middle"}
            >
              {at(tick.at)}
            </text>
          ))}
        </g>
        <path d={chart.area} fill="currentColor" fillOpacity="0.12" stroke="none" />
        <path
          d={chart.line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {chart.dots.length === 1 ? (
          <circle cx={chart.dots[0]?.x} cy={chart.dots[0]?.y} r="3" fill="currentColor" />
        ) : null}
      </svg>
    </Card>
  );
}
