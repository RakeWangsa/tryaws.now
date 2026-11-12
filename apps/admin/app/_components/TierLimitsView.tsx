import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type { AuditRow } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { saveTierLimitsAction } from "../../server/pricing-actions.ts";
import type { Loaded } from "../../server/pricing-data.ts";
import type { TierLimitsLine, TierLimitsScreen } from "../../server/tier-limits-data.ts";

const RESULT_CODES = [
  "ok",
  "replayed",
  "invalid",
  "denied",
  "conflict",
  "not_found",
  "rate_limited",
  "unavailable",
] as const;
type ResultCode = (typeof RESULT_CODES)[number];
const resultOf = (value: string | null): ResultCode | null =>
  RESULT_CODES.find((c) => c === value) ?? null;

function Banner({ code }: { code: ResultCode | null }) {
  const t = useTranslations("AdminTierLimits.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function MarketForm({ locale, screen }: { locale: Locale; screen: TierLimitsScreen }) {
  const t = useTranslations("AdminTierLimits.market");
  return (
    <form method="get" action={localePath(locale, "/catalog/limits")} className="mb-3">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="limits-market">
          {t("label")}
        </label>
        <select
          id="limits-market"
          name="market"
          className="form-control"
          defaultValue={screen.market}
        >
          {screen.markets.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="primary" size="sm">
        {t("submit")}
      </Button>
    </form>
  );
}

function Yes({ value }: { value: boolean }) {
  const t = useTranslations("AdminTierLimits.values");
  return <>{value ? t("yes") : t("no")}</>;
}

function Editor({
  locale,
  screen,
  line,
}: {
  locale: Locale;
  screen: TierLimitsScreen;
  line: TierLimitsLine;
}) {
  const t = useTranslations("AdminTierLimits.editor");
  // The form opens on the limits in force; a tier whose row cannot be read opens on the defaults.
  const open = line.limits ?? line.defaults;
  const id = (name: string): string => `limits-${line.tier}-${name}`;
  return (
    <form action={saveTierLimitsAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="market" value={screen.market} />
      <input type="hidden" name="tier" value={line.tier} />
      <FormBlock>
        <Field
          name="maxInstances"
          id={id("instances")}
          label={t("maxInstances")}
          hint={t("maxInstancesHint")}
          required
          defaultValue={String(open.maxInstances)}
          maxLength={6}
          autoComplete="off"
          inputMode="numeric"
        />
        <Field
          name="maxBundleUsd"
          id={id("bundle")}
          label={t("maxBundleUsd")}
          hint={t("maxBundleUsdHint")}
          required
          defaultValue={open.maxBundleUsd}
          maxLength={11}
          autoComplete="off"
          inputMode="decimal"
        />
        <Field
          name="maxStaticIps"
          id={id("static")}
          label={t("maxStaticIps")}
          hint={t("maxStaticIpsHint")}
          required
          defaultValue={String(open.maxStaticIps)}
          maxLength={6}
          autoComplete="off"
          inputMode="numeric"
        />
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor={id("windows")}>
            <input
              type="checkbox"
              id={id("windows")}
              name="windows"
              value="on"
              defaultChecked={open.windows}
              className="me-2"
            />
            {t("windows")}
          </label>
        </div>
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor={id("containers")}>
            <input
              type="checkbox"
              id={id("containers")}
              name="containers"
              value="on"
              defaultChecked={open.containers}
              className="me-2"
            />
            {t("containers")}
          </label>
        </div>
        <Field
          name="reason"
          id={id("reason")}
          label={t("reason")}
          hint={t("reasonHint")}
          required
          maxLength={500}
          autoComplete="off"
        />
      </FormBlock>
      <SubmitButton variant="primary" size="sm">
        {t("save")}
      </SubmitButton>
    </form>
  );
}

function HistoryTable({ line }: { line: TierLimitsLine }) {
  const t = useTranslations("AdminTierLimits.history");
  const columns: DataTableColumn<AuditRow>[] = [
    {
      key: "when",
      header: t("when"),
      cell: (r) => <DateText value={r.createdAt} variant="datetime" />,
    },
    {
      key: "who",
      header: t("by"),
      cell: (r) => (r.actorId === null ? "-" : `#${r.actorId.slice(0, 8)}`),
    },
    { key: "change", header: t("change"), cell: (r) => changeOf(r) },
    { key: "reason", header: t("reason"), cell: (r) => r.reason ?? "-" },
  ];
  return (
    <>
      <h3 className="h5 mergecolor">{t("title")}</h3>
      {line.history.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        <DataTable
          caption={t("caption", { tier: line.tier })}
          columns={columns}
          rows={[...line.history]}
          rowKey={(r) => r.id}
        />
      )}
    </>
  );
}

// The counts in an audit row, as plain numbers only: never the row itself.
function countOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "maxInstances" in value) {
    const n = (value as { maxInstances: unknown }).maxInstances;
    if (typeof n === "number" && Number.isSafeInteger(n)) return String(n);
  }
  return "-";
}

function changeOf(row: AuditRow): string {
  return `${countOf(row.before)} > ${countOf(row.after)}`;
}

function TierCard({
  locale,
  screen,
  line,
}: {
  locale: Locale;
  screen: TierLimitsScreen;
  line: TierLimitsLine;
}) {
  const t = useTranslations("AdminTierLimits");
  const names = useTranslations("AdminTierLimits.tiers");
  const { limits } = line;
  return (
    <Card title={names(line.tier)}>
      <p className="mb-2">
        <Badge tone={line.source === "stored" ? "purple" : "grey"}>
          {t(`source.${line.source}`)}
        </Badge>
      </p>
      {line.source === "invalid" ? (
        <p role="alert">{t("invalid")}</p>
      ) : limits === null ? null : (
        <ul className="list-unstyled mb-3">
          <li>
            {t("editor.maxInstances")}: <strong>{limits.maxInstances}</strong>
          </li>
          <li>
            {t("editor.maxBundleUsd")}: <strong>{limits.maxBundleUsd}</strong>
          </li>
          <li>
            {t("editor.maxStaticIps")}: <strong>{limits.maxStaticIps}</strong>
          </li>
          <li>
            {t("editor.windows")}: <Yes value={limits.windows} />
          </li>
          <li>
            {t("editor.containers")}: <Yes value={limits.containers} />
          </li>
        </ul>
      )}
      <Editor locale={locale} screen={screen} line={line} />
      <HistoryTable line={line} />
    </Card>
  );
}

export interface TierLimitsViewProps {
  locale: Locale;
  screen: Loaded<TierLimitsScreen>;
  result: string | null;
}

// 16.12 /catalog/limits: the limits of each risk tier in a market. A saved setting replaces the defaults of
// the core; a row that cannot be read refuses the tier (fail closed). Lowering a limit does not touch what
// a customer already has: it stops new orders past the limit.
export function TierLimitsView({ locale, screen, result }: TierLimitsViewProps) {
  const t = useTranslations("AdminTierLimits");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="form-text seccolor">{t("intro")}</p>
      <form method="get" action={localePath(locale, "/catalog")} className="mb-3">
        <Button type="submit" variant="secondary" size="sm">
          {t("back")}
        </Button>
      </form>
      <Banner code={resultOf(result)} />
      {screen.kind !== "ok" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : (
        <>
          <Card>
            <MarketForm locale={locale} screen={screen.value} />
          </Card>
          {screen.value.lines.map((line) => (
            <TierCard key={line.tier} locale={locale} screen={screen.value} line={line} />
          ))}
        </>
      )}
    </>
  );
}
