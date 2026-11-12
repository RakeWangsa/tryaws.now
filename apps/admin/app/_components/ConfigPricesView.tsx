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
  MoneyText,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type { ConfigPricePreview } from "@tc/core";
import type { AuditRow, ConfigPriceEntry } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import type {
  ConfigEditPreview,
  ConfigPriceEdit,
  ConfigPriceLine,
  ConfigPriceScreen,
} from "../../server/config-price-data.ts";
import { saveConfigPriceAction } from "../../server/pricing-actions.ts";
import type { Loaded } from "../../server/pricing-data.ts";

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

// The short id of a key for the messages: "config_price.dns_zone_month" is "dns_zone_month".
const shortOf = (key: string): string => key.slice("config_price.".length);

function Banner({ code }: { code: ResultCode | null }) {
  const t = useTranslations("AdminConfigPrices.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function PriceName({ id }: { id: string }) {
  const t = useTranslations("AdminConfigPrices.names");
  return <>{t(shortOf(id) as "dns_zone_month")}</>;
}

function UnitName({ unit }: { unit: string }) {
  const t = useTranslations("AdminConfigPrices.unit");
  return <>{t(unit as "month")}</>;
}

function MarketForm({ locale, screen }: { locale: Locale; screen: ConfigPriceScreen }) {
  const t = useTranslations("AdminConfigPrices.market");
  return (
    <form method="get" action={localePath(locale, "/pricing/config")} className="mb-3">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="config-market">
          {t("label")}
        </label>
        <select
          id="config-market"
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

function SummaryCard({ locale, screen }: { locale: Locale; screen: ConfigPriceScreen }) {
  const t = useTranslations("AdminConfigPrices.summary");
  return (
    <Card>
      <MarketForm locale={locale} screen={screen} />
      {screen.fx === null ? (
        <p role="alert">{t("noFx")}</p>
      ) : (
        <p className="mb-1">
          {t("fx")}: <strong>{screen.fx.rate}</strong>
        </p>
      )}
      <p className="mb-0">
        {t("rounding")}: <strong>{t("roundingValue")}</strong>
      </p>
    </Card>
  );
}

function ListCard({ locale, screen }: { locale: Locale; screen: ConfigPriceScreen }) {
  const t = useTranslations("AdminConfigPrices");
  const columns: DataTableColumn<ConfigPriceLine>[] = [
    { key: "name", header: t("columns.name"), cell: (l) => <PriceName id={l.key} /> },
    { key: "unit", header: t("columns.unit"), cell: (l) => <UnitName unit={l.unit} /> },
    {
      key: "usd",
      header: t("columns.usd"),
      cell: (l) =>
        l.invalid ? (
          <Badge tone="grey">{t("state.invalid")}</Badge>
        ) : l.inForce === null ? (
          t("state.none")
        ) : (
          l.inForce.usd
        ),
    },
    {
      key: "customer",
      header: t("columns.customer"),
      cell: (l) =>
        l.customerPrice === null ? "-" : <MoneyText minor={l.customerPrice.totalMinor} />,
    },
    {
      key: "scheduled",
      header: t("columns.scheduled"),
      cell: (l) =>
        l.scheduled === null ? (
          "-"
        ) : (
          <>
            {l.scheduled.usd} (<DateText value={l.scheduled.from} variant="datetime" />)
          </>
        ),
    },
    {
      key: "used",
      header: t("columns.used"),
      cell: (l) => (
        <Badge tone={l.readByOrders ? "purple" : "grey"}>
          {l.readByOrders ? t("state.readNow") : t("state.notReadYet")}
        </Badge>
      ),
    },
    {
      key: "edit",
      header: "",
      cell: (l) => (
        <form method="get" action={localePath(locale, "/pricing/config")}>
          <input type="hidden" name="market" value={screen.market} />
          <input type="hidden" name="key" value={l.key} />
          <Button type="submit" variant="secondary" size="sm">
            {t("editor.edit")}
          </Button>
        </form>
      ),
    },
  ];
  return (
    <Card title={t("list.title")}>
      <p className="form-text seccolor">{t("list.intro")}</p>
      <DataTable
        caption={t("list.caption")}
        columns={columns}
        rows={[...screen.lines]}
        rowKey={(l) => l.key}
      />
    </Card>
  );
}

function PreviewBlock({ preview, id }: { preview: ConfigEditPreview; id: string }) {
  const t = useTranslations("AdminConfigPrices.preview");
  if (preview.kind === "none") return null;
  if (preview.kind === "invalid") {
    return <p role="alert">{t("invalid", { fields: preview.fields.join(", ") })}</p>;
  }
  if (preview.kind === "unavailable") return <p role="alert">{t("unavailable")}</p>;
  const p: ConfigPricePreview = preview.preview;
  const rows = [
    {
      id: "one",
      now: p.current === null ? null : p.current.totalMinor,
      next: p.candidate.totalMinor,
      margin: p.candidate.marginMinor,
      commission: p.candidate.commissionMinor,
      change: p.deltaMinor,
    },
  ];
  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    {
      key: "now",
      header: t("priceNow"),
      cell: (r) => (r.now === null ? "-" : <MoneyText minor={r.now} />),
    },
    { key: "new", header: t("priceNew"), cell: (r) => <MoneyText minor={r.next} /> },
    { key: "margin", header: t("margin"), cell: (r) => <MoneyText minor={r.margin} /> },
    { key: "commission", header: t("commission"), cell: (r) => <MoneyText minor={r.commission} /> },
    {
      key: "change",
      header: t("change"),
      cell: (r) => (r.change === null ? "-" : <MoneyText minor={r.change} />),
    },
  ];
  return (
    <>
      <DataTable
        caption={t("caption", { name: shortOf(id) })}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
      />
      <p className="form-text seccolor">{t("onlyNew")}</p>
    </>
  );
}

function Editor({
  locale,
  screen,
  edit,
  line,
}: {
  locale: Locale;
  screen: ConfigPriceScreen;
  edit: ConfigPriceEdit;
  line: ConfigPriceLine;
}) {
  const t = useTranslations("AdminConfigPrices.editor");
  const p = useTranslations("AdminConfigPrices.preview");
  const r = useTranslations("AdminConfigPrices.reason");
  const good = edit.go && edit.preview.kind === "ok";
  return (
    <>
      <p className="form-text seccolor">{t("intro")}</p>
      {line.readByOrders ? null : <p className="form-text seccolor">{t("notReadYet")}</p>}
      <form method="get" action={localePath(locale, "/pricing/config")}>
        <input type="hidden" name="market" value={screen.market} />
        <input type="hidden" name="key" value={edit.key} />
        <input type="hidden" name="go" value="preview" />
        <FormBlock>
          <Field
            name="usd"
            id="config-usd"
            label={t("usd")}
            hint={t("usdHint")}
            required
            defaultValue={edit.usd}
            maxLength={14}
            autoComplete="off"
            inputMode="decimal"
          />
          <Field
            name="from"
            id="config-from"
            label={t("from")}
            hint={t("fromHint")}
            optional
            defaultValue={edit.from}
            maxLength={16}
            autoComplete="off"
          />
        </FormBlock>
        <Button type="submit" variant="secondary" size="sm">
          {t("previewSubmit")}
        </Button>
      </form>
      {edit.go ? <PreviewBlock preview={edit.preview} id={edit.key} /> : null}
      {good ? (
        <form action={saveConfigPriceAction}>
          <h3 className="h5 mergecolor">{p("saveTitle")}</h3>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="market" value={screen.market} />
          <input type="hidden" name="key" value={edit.key} />
          <input type="hidden" name="usd" value={edit.usd} />
          <input type="hidden" name="from" value={edit.from} />
          <Field
            name="reason"
            id="config-reason"
            label={r("label")}
            hint={r("hint")}
            required
            maxLength={500}
            autoComplete="off"
          />
          <SubmitButton variant="primary" size="sm">
            {p("save")}
          </SubmitButton>
        </form>
      ) : null}
    </>
  );
}

function HistoryCard({ line, edit }: { line: ConfigPriceLine; edit: ConfigPriceEdit }) {
  const t = useTranslations("AdminConfigPrices.history");
  const now = Date.now();
  // Newest first. The entry in force is the last one that has started.
  const rows = [...line.entries].reverse();
  const stateOf = (e: ConfigPriceEntry): "inForce" | "scheduled" | "past" =>
    e.from.getTime() > now
      ? "scheduled"
      : line.inForce?.from.getTime() === e.from.getTime()
        ? "inForce"
        : "past";
  const columns: DataTableColumn<ConfigPriceEntry>[] = [
    { key: "from", header: t("from"), cell: (e) => <DateText value={e.from} variant="datetime" /> },
    { key: "state", header: t("state"), cell: (e) => t(stateOf(e)) },
    { key: "usd", header: t("usd"), cell: (e) => e.usd },
    { key: "by", header: t("by"), cell: (e) => (e.by === null ? "-" : `#${e.by.slice(0, 8)}`) },
  ];
  const audit: DataTableColumn<AuditRow>[] = [
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
    { key: "reason", header: t("reason"), cell: (r) => r.reason ?? "-" },
  ];
  return (
    <>
      <h3 className="h5 mergecolor">{t("title")}</h3>
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        <DataTable
          caption={t("caption", { name: shortOf(line.key) })}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.from.toISOString()}
        />
      )}
      {edit.history.length === 0 ? null : (
        <DataTable
          caption={t("auditCaption")}
          columns={audit}
          rows={[...edit.history]}
          rowKey={(r) => r.id}
        />
      )}
    </>
  );
}

export interface ConfigPricesViewProps {
  locale: Locale;
  screen: Loaded<ConfigPriceScreen>;
  result: string | null;
}

// 16.12 /pricing/config: the prices that no AWS API fills (load balancer, snapshot and block storage per
// GB, hosted zone). Each has dated entries, a live preview by the pricing engine, a history with the
// reason of every change, and an editor that saves only under a good preview. New orders only.
export function ConfigPricesView({ locale, screen, result }: ConfigPricesViewProps) {
  const t = useTranslations("AdminConfigPrices");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="form-text seccolor">{t("intro")}</p>
      <form method="get" action={localePath(locale, "/pricing")} className="mb-3">
        <Button type="submit" variant="secondary" size="sm">
          {t("back")}
        </Button>
      </form>
      <Banner code={resultOf(result)} />
      {screen.kind !== "ok" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : (
        <>
          <SummaryCard locale={locale} screen={screen.value} />
          <ListCard locale={locale} screen={screen.value} />
          {screen.value.edit === null
            ? null
            : (() => {
                const edit = screen.value.edit;
                const line = screen.value.lines.find((l) => l.key === edit.key);
                if (line === undefined) return null;
                return (
                  <Card title={t("editor.title", { name: shortOf(line.key) })}>
                    <Editor locale={locale} screen={screen.value} edit={edit} line={line} />
                    <HistoryCard line={line} edit={edit} />
                  </Card>
                );
              })()}
        </>
      )}
    </>
  );
}
