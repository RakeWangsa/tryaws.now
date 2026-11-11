import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  MoneyText,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type { FlagState } from "@tc/core";
import { localePath, type Locale } from "@tc/ui/runtime";
import { dependenciesOf, missingDependencies } from "../../server/flag-dependencies.ts";
import { setFlagAction } from "../../server/pricing-actions.ts";
import type { CatalogFamily, CatalogScreen, Loaded } from "../../server/pricing-data.ts";

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

function MarketForm({ locale, screen }: { locale: Locale; screen: CatalogScreen }) {
  const t = useTranslations("AdminCatalog.market");
  return (
    <form method="get" action={localePath(locale, "/catalog")} className="mb-4">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="catalog-market">
          {t("label")}
        </label>
        <select
          id="catalog-market"
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

function FlagsCard({ locale, screen }: { locale: Locale; screen: CatalogScreen }) {
  const t = useTranslations("AdminCatalog.flags");
  const enabled = new Set(screen.flags.filter((f) => f.enabled).map((f) => f.key as string));
  const columns: DataTableColumn<FlagState>[] = [
    { key: "family", header: t("family"), cell: (row) => t(`names.${row.key}`) },
    {
      key: "state",
      header: t("state"),
      cell: (row) => (
        <Badge tone={row.enabled ? "purple" : "grey"}>{row.enabled ? t("on") : t("off")}</Badge>
      ),
    },
    {
      key: "needs",
      header: t("needs"),
      cell: (row) => {
        const needs = dependenciesOf(row.key);
        if (needs.length === 0) return t("needsNone");
        const missing = missingDependencies(row.key, enabled);
        const names = needs.map((k) => t(`names.${k as "linux_instance"}`)).join(", ");
        return missing.length === 0
          ? names
          : `${names}. ${t("missing", { list: missing.map((k) => t(`names.${k as "linux_instance"}`)).join(", ") })}`;
      },
    },
    {
      key: "act",
      header: "",
      cell: (row) => (
        <form action={setFlagAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="market" value={screen.market} />
          <input type="hidden" name="key" value={row.key} />
          <input type="hidden" name="turn" value={row.enabled ? "off" : "on"} />
          <Field
            name="reason"
            id={`flag-reason-${row.key}`}
            label={t("reasonHint")}
            required
            maxLength={500}
            autoComplete="off"
          />
          <SubmitButton variant={row.enabled ? "destructive" : "primary"} size="sm">
            {row.enabled ? t("turnOff") : t("turnOn")}
          </SubmitButton>
        </form>
      ),
    },
  ];
  return (
    <Card title={t("title")}>
      <p className="form-text seccolor">{t("intro")}</p>
      <DataTable
        caption={t("caption")}
        columns={columns}
        rows={[...screen.flags]}
        rowKey={(row) => row.key}
      />
    </Card>
  );
}

type ProductRow = CatalogFamily["rows"][number];

function FamilyTable({ family }: { family: CatalogFamily }) {
  const t = useTranslations("AdminCatalog.products");
  const columns: DataTableColumn<ProductRow>[] = [
    { key: "plan", header: t("plan"), cell: (r) => r.row.awsId },
    { key: "region", header: t("region"), cell: (r) => r.row.region },
    { key: "platform", header: t("platform"), cell: (r) => r.row.platform ?? "-" },
    { key: "aws", header: t("aws"), cell: (r) => r.row.awsPriceUsd },
    {
      key: "price",
      header: t("price"),
      cell: (r) =>
        r.price === null ? t("noPrice") : <MoneyText minor={r.price.priceBdt.totalMinor} />,
    },
    {
      key: "state",
      header: t("state"),
      cell: (r) => (
        <Badge tone={r.row.active ? "purple" : "grey"}>
          {r.row.active ? t("active") : t("inactive")}
        </Badge>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("caption", { family: family.family })}
      columns={columns}
      rows={[...family.rows]}
      rowKey={(r) => r.row.id}
    />
  );
}

function ProductsCard({ screen }: { screen: CatalogScreen }) {
  const t = useTranslations("AdminCatalog.products");
  return (
    <Card title={t("title")}>
      <p className="form-text seccolor">{t("intro")}</p>
      {screen.families.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        screen.families.map((family) => (
          <div key={family.family} className="mb-4">
            <h3 className="h5 mergecolor">{family.family}</h3>
            {family.lastSyncedAt === null ? null : (
              <p className="mb-2">
                {t("synced")}: <DateText value={family.lastSyncedAt} variant="datetime" />
              </p>
            )}
            <FamilyTable family={family} />
          </div>
        ))
      )}
      <p className="form-text seccolor">{t("activeHint")}</p>
    </Card>
  );
}

export interface CatalogViewProps {
  locale: Locale;
  screen: Loaded<CatalogScreen>;
  result: string | null;
}

// 16.12 /catalog: the synced products with their selling price (computed by the engine, never stored)
// and the feature flags of a market. Nothing synced from AWS is editable here.
export function CatalogView({ locale, screen, result }: CatalogViewProps) {
  const t = useTranslations("AdminCatalog");
  const tr = useTranslations("AdminCatalog.result");
  const code = resultOf(result);
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      {code === null ? null : (
        <p
          role={code === "ok" || code === "replayed" ? "status" : "alert"}
          className="form-text seccolor mb-3"
        >
          {tr(code)}
        </p>
      )}
      {screen.kind !== "ok" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : (
        <>
          <Card>
            <MarketForm locale={locale} screen={screen.value} />
          </Card>
          <FlagsCard locale={locale} screen={screen.value} />
          <ProductsCard screen={screen.value} />
        </>
      )}
    </>
  );
}
