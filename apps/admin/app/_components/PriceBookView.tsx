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
import type { BookPreviewRow } from "@tc/core";
import type { AuditRow, PriceBookAmount, PriceBookEntry } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { fractionToPercent } from "../../server/price-book-draft.ts";
import type {
  EditPreview,
  PriceListEdit,
  PriceListFamily,
  PriceListProduct,
  PriceListScreen,
} from "../../server/price-book-data.ts";
import { saveBookAction, setBaseCostAction } from "../../server/pricing-actions.ts";
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

function Banner({ code }: { code: ResultCode | null }) {
  const t = useTranslations("AdminPriceBook.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function FamilyName({ family }: { family: string }) {
  const names = useTranslations("AdminCatalog.flags.names");
  return <>{names(family as "linux_instance")}</>;
}

function Amount({ amount }: { amount: PriceBookAmount | null }) {
  const t = useTranslations("AdminPriceBook.amount");
  if (amount === null) return <>{t("none")}</>;
  if (amount.kind === "percent")
    return <>{t("percent", { value: fractionToPercent(amount.value) })}</>;
  return (
    <>
      <MoneyText minor={BigInt(amount.value)} /> {t("perUnit")}
    </>
  );
}

function Hidden({ locale, market, family }: { locale: Locale; market: string; family: string }) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="market" value={market} />
      <input type="hidden" name="family" value={family} />
    </>
  );
}

function ReasonField({ id }: { id: string }) {
  const t = useTranslations("AdminPriceBook.reason");
  return (
    <Field
      name="reason"
      id={id}
      label={t("label")}
      hint={t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function MarketForm({ locale, screen }: { locale: Locale; screen: PriceListScreen }) {
  const t = useTranslations("AdminPriceBook.market");
  return (
    <form method="get" action={localePath(locale, "/pricing/book")} className="mb-3">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="book-market">
          {t("label")}
        </label>
        <select
          id="book-market"
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

function SummaryCard({ locale, screen }: { locale: Locale; screen: PriceListScreen }) {
  const t = useTranslations("AdminPriceBook.summary");
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

function ProductsTable({ family, fx }: { family: PriceListFamily; fx: string | null }) {
  const t = useTranslations("AdminPriceBook");
  const columns: DataTableColumn<PriceListProduct>[] = [
    { key: "region", header: t("columns.region"), cell: (r) => r.row.region },
    { key: "plan", header: t("columns.plan"), cell: (r) => r.row.awsId },
    { key: "aws", header: t("columns.aws"), cell: (r) => r.row.awsPriceUsd },
    { key: "fx", header: t("columns.fx"), cell: () => fx ?? "-" },
    {
      key: "margin",
      header: t("columns.margin"),
      cell: (r) => (r.price === null ? "-" : <MoneyText minor={r.price.marginMinor} />),
    },
    {
      key: "commission",
      header: t("columns.commission"),
      cell: (r) => (r.price === null ? "-" : <MoneyText minor={r.price.commissionMinor} />),
    },
    {
      key: "price",
      header: t("columns.price"),
      cell: (r) => (r.price === null ? "-" : <MoneyText minor={r.price.priceBdt.totalMinor} />),
    },
    {
      key: "state",
      header: t("columns.state"),
      cell: (r) => (
        <Badge tone={r.row.active ? "purple" : "grey"}>
          {r.row.active ? t("columns.active") : t("columns.inactive")}
        </Badge>
      ),
    },
  ];
  return (
    <DataTable
      caption={t("family.caption", { family: family.family })}
      columns={columns}
      rows={[...family.products]}
      rowKey={(r) => r.row.id}
    />
  );
}

function FamilyCard({
  locale,
  screen,
  family,
}: {
  locale: Locale;
  screen: PriceListScreen;
  family: PriceListFamily;
}) {
  const t = useTranslations("AdminPriceBook.family");
  const { inForce, scheduled } = family;
  return (
    <Card title={<FamilyName family={family.family} />}>
      <p className="mb-2">
        <Badge tone={family.enabled ? "purple" : "grey"}>
          {family.enabled ? t("on") : t("off")}
        </Badge>
      </p>
      {family.invalid ? (
        <p role="alert">{t("invalid")}</p>
      ) : inForce === null ? (
        <p className="form-text seccolor">{t("noTerms")}</p>
      ) : (
        <p className="mb-2">
          {t("terms")}: <Amount amount={inForce.margin} /> / <Amount amount={inForce.commission} />{" "}
          (<DateText value={inForce.from} variant="datetime" />)
        </p>
      )}
      {scheduled === null ? null : (
        <p className="mb-2">
          {t("scheduled")}: <Amount amount={scheduled.margin} /> /{" "}
          <Amount amount={scheduled.commission} /> (
          <DateText value={scheduled.from} variant="datetime" />)
        </p>
      )}
      {family.products.length === 0 ? (
        <p className="form-text seccolor">{t("noProducts")}</p>
      ) : (
        <ProductsTable family={family} fx={screen.fx?.rate ?? null} />
      )}
      <form method="get" action={localePath(locale, "/pricing/book")} className="mt-3">
        <input type="hidden" name="market" value={screen.market} />
        <input type="hidden" name="family" value={family.family} />
        <Button type="submit" variant="secondary" size="sm">
          {t("edit")}
        </Button>
      </form>
    </Card>
  );
}

function KindSelect({
  name,
  id,
  label,
  value,
  withNone,
}: {
  name: string;
  id: string;
  label: string;
  value: string;
  withNone: boolean;
}) {
  const t = useTranslations("AdminPriceBook.editor");
  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={name} className="form-control" defaultValue={value}>
        {withNone ? <option value="none">{t("kindNone")}</option> : null}
        <option value="percent">{t("kindPercent")}</option>
        <option value="fixed">{t("kindFixed")}</option>
      </select>
    </div>
  );
}

function PreviewTable({
  rows,
  fromSamples,
  family,
}: {
  rows: readonly BookPreviewRow[];
  fromSamples: boolean;
  family: string;
}) {
  const t = useTranslations("AdminPriceBook.preview");
  const columns: DataTableColumn<BookPreviewRow>[] = [
    {
      key: "plan",
      header: t("title"),
      cell: (r) =>
        fromSamples
          ? t("sample", { n: r.productId.replace("sample_", "") })
          : `${r.region} ${r.awsId}`,
    },
    { key: "awsNow", header: t("awsNow"), cell: (r) => r.currentAwsPriceUsd },
    { key: "awsNew", header: t("awsNew"), cell: (r) => r.awsPriceUsd },
    {
      key: "now",
      header: t("priceNow"),
      cell: (r) => (r.current === null ? "-" : <MoneyText minor={r.current.totalMinor} />),
    },
    {
      key: "new",
      header: t("priceNew"),
      cell: (r) => <MoneyText minor={r.candidate.totalMinor} />,
    },
    {
      key: "margin",
      header: t("margin"),
      cell: (r) => <MoneyText minor={r.candidate.marginMinor} />,
    },
    {
      key: "commission",
      header: t("commission"),
      cell: (r) => <MoneyText minor={r.candidate.commissionMinor} />,
    },
    {
      key: "change",
      header: t("change"),
      cell: (r) => (r.deltaMinor === null ? "-" : <MoneyText minor={r.deltaMinor} />),
    },
  ];
  return (
    <DataTable
      caption={t("caption", { family })}
      columns={columns}
      rows={[...rows]}
      rowKey={(r) => r.productId}
    />
  );
}

function PreviewBlock({ preview, family }: { preview: EditPreview; family: string }) {
  const t = useTranslations("AdminPriceBook.preview");
  if (preview.kind === "none") return null;
  if (preview.kind === "invalid") {
    return <p role="alert">{t("invalid", { fields: preview.fields.join(", ") })}</p>;
  }
  if (preview.kind === "unavailable") return <p role="alert">{t("unavailable")}</p>;
  return (
    <>
      {preview.preview.fromSamples ? <p className="form-text seccolor">{t("samples")}</p> : null}
      <PreviewTable
        rows={preview.preview.rows}
        fromSamples={preview.preview.fromSamples}
        family={family}
      />
      <p className="form-text seccolor">{t("onlyNew")}</p>
    </>
  );
}

function TermsEditor({
  locale,
  screen,
  edit,
}: {
  locale: Locale;
  screen: PriceListScreen;
  edit: PriceListEdit;
}) {
  const t = useTranslations("AdminPriceBook.editor");
  const p = useTranslations("AdminPriceBook.preview");
  const { draft } = edit;
  const good = edit.go === "terms" && edit.preview.kind === "ok";
  return (
    <>
      <p className="form-text seccolor">{t("intro")}</p>
      <form method="get" action={localePath(locale, "/pricing/book")}>
        <input type="hidden" name="market" value={screen.market} />
        <input type="hidden" name="family" value={edit.family} />
        <input type="hidden" name="go" value="terms" />
        <FormBlock>
          <KindSelect
            name="marginKind"
            id="book-margin-kind"
            label={t("marginKind")}
            value={draft.marginKind}
            withNone={false}
          />
          <Field
            name="margin"
            id="book-margin"
            label={t("margin")}
            hint={t("marginHint")}
            required
            defaultValue={draft.margin}
            maxLength={12}
            autoComplete="off"
            inputMode="decimal"
          />
          <KindSelect
            name="commissionKind"
            id="book-commission-kind"
            label={t("commissionKind")}
            value={draft.commissionKind}
            withNone
          />
          <Field
            name="commission"
            id="book-commission"
            label={t("commission")}
            hint={t("commissionHint")}
            optional
            defaultValue={draft.commission}
            maxLength={12}
            autoComplete="off"
            inputMode="decimal"
          />
          <Field
            name="from"
            id="book-from"
            label={t("from")}
            hint={t("fromHint")}
            optional
            defaultValue={draft.from}
            maxLength={16}
            autoComplete="off"
          />
        </FormBlock>
        <Button type="submit" variant="secondary" size="sm">
          {t("previewSubmit")}
        </Button>
      </form>
      {edit.go === "terms" ? <PreviewBlock preview={edit.preview} family={edit.family} /> : null}
      {good ? (
        <form action={saveBookAction}>
          <h3 className="h5 mergecolor">{p("saveTitle")}</h3>
          <Hidden locale={locale} market={screen.market} family={edit.family} />
          <input type="hidden" name="marginKind" value={draft.marginKind} />
          <input type="hidden" name="margin" value={draft.margin} />
          <input type="hidden" name="commissionKind" value={draft.commissionKind} />
          <input type="hidden" name="commission" value={draft.commission} />
          <input type="hidden" name="from" value={draft.from} />
          <ReasonField id="book-reason" />
          <SubmitButton variant="primary" size="sm">
            {p("save")}
          </SubmitButton>
        </form>
      ) : null}
    </>
  );
}

function HistoryCard({ family }: { family: PriceListFamily }) {
  const t = useTranslations("AdminPriceBook.history");
  const now = Date.now();
  // Newest first. The entry in force is the last one that has started.
  const rows = [...family.entries].reverse();
  const stateOf = (e: PriceBookEntry): "inForce" | "scheduled" | "past" =>
    e.from.getTime() > now
      ? "scheduled"
      : family.inForce?.from.getTime() === e.from.getTime()
        ? "inForce"
        : "past";
  const columns: DataTableColumn<PriceBookEntry>[] = [
    { key: "from", header: t("from"), cell: (e) => <DateText value={e.from} variant="datetime" /> },
    { key: "state", header: t("state"), cell: (e) => t(stateOf(e)) },
    { key: "margin", header: "%", cell: (e) => <Amount amount={e.margin} /> },
    { key: "commission", header: "+", cell: (e) => <Amount amount={e.commission} /> },
    { key: "by", header: t("by"), cell: (e) => (e.by === null ? "-" : `#${e.by.slice(0, 8)}`) },
  ];
  return (
    <>
      <h3 className="h5 mergecolor">{t("title")}</h3>
      {rows.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        <DataTable
          caption={t("caption", { family: family.family })}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.from.toISOString()}
        />
      )}
    </>
  );
}

function BaseCostEditor({
  locale,
  screen,
  edit,
  family,
}: {
  locale: Locale;
  screen: PriceListScreen;
  edit: PriceListEdit;
  family: PriceListFamily;
}) {
  const t = useTranslations("AdminPriceBook.base");
  const p = useTranslations("AdminPriceBook.preview");
  const good = edit.go === "base" && edit.preview.kind === "ok";
  const history: DataTableColumn<AuditRow>[] = [
    {
      key: "when",
      header: t("when"),
      cell: (r) => <DateText value={r.createdAt} variant="datetime" />,
    },
    {
      key: "who",
      header: t("who"),
      cell: (r) => (r.actorId === null ? "-" : `#${r.actorId.slice(0, 8)}`),
    },
    {
      key: "change",
      header: t("change"),
      cell: (r) => t("arrow", { before: priceOf(r.before), after: priceOf(r.after) }),
    },
    { key: "reason", header: t("reason"), cell: (r) => r.reason ?? "-" },
  ];
  return (
    <>
      <h3 className="h5 mergecolor">{t("title")}</h3>
      <p className="form-text seccolor">{t("intro")}</p>
      <form method="get" action={localePath(locale, "/pricing/book")}>
        <input type="hidden" name="market" value={screen.market} />
        <input type="hidden" name="family" value={edit.family} />
        <input type="hidden" name="go" value="base" />
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="base-product">
            {t("product")}
          </label>
          <select
            id="base-product"
            name="product"
            className="form-control"
            defaultValue={edit.baseProduct}
          >
            {family.products.map((r) => (
              <option key={r.row.id} value={r.row.id}>
                {`${r.row.region} ${r.row.awsId} (${t("current")}: ${r.row.awsPriceUsd})`}
              </option>
            ))}
          </select>
        </div>
        <Field
          name="usd"
          id="base-usd"
          label={t("usd")}
          hint={t("usdHint")}
          required
          defaultValue={edit.baseUsd}
          maxLength={14}
          autoComplete="off"
          inputMode="decimal"
        />
        <Button type="submit" variant="secondary" size="sm">
          {t("previewSubmit")}
        </Button>
      </form>
      {edit.go === "base" ? <PreviewBlock preview={edit.preview} family={edit.family} /> : null}
      {good ? (
        <form action={setBaseCostAction}>
          <h3 className="h5 mergecolor">{p("saveTitle")}</h3>
          <Hidden locale={locale} market={screen.market} family={edit.family} />
          <input type="hidden" name="product" value={edit.baseProduct} />
          <input type="hidden" name="usd" value={edit.baseUsd} />
          <ReasonField id="base-reason" />
          <SubmitButton variant="primary" size="sm">
            {p("saveBase")}
          </SubmitButton>
        </form>
      ) : null}
      <h3 className="h5 mergecolor">{t("historyTitle")}</h3>
      {edit.baseHistory.length === 0 ? (
        <EmptyState title={t("historyEmpty")} description="" />
      ) : (
        <DataTable
          caption={t("historyCaption")}
          columns={history}
          rows={[...edit.baseHistory]}
          rowKey={(r) => r.id}
        />
      )}
    </>
  );
}

// The price in an audit row: only a plain decimal text of the row is shown, never the row itself.
function priceOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "awsPriceUsd" in value) {
    const usd = (value as { awsPriceUsd: unknown }).awsPriceUsd;
    if (typeof usd === "string" && /^\d{1,8}(\.\d{1,4})?$/.test(usd)) return usd;
  }
  return "-";
}

function EditCard({
  locale,
  screen,
  edit,
}: {
  locale: Locale;
  screen: PriceListScreen;
  edit: PriceListEdit;
}) {
  const t = useTranslations("AdminPriceBook.editor");
  const family = screen.families.find((f) => f.family === edit.family);
  if (family === undefined) return null;
  return (
    <Card title={t("title", { family: edit.family })}>
      <TermsEditor locale={locale} screen={screen} edit={edit} />
      <HistoryCard family={family} />
      {family.baseEditable && family.products.length > 0 ? (
        <BaseCostEditor locale={locale} screen={screen} edit={edit} family={family} />
      ) : null}
    </Card>
  );
}

export interface PriceBookViewProps {
  locale: Locale;
  screen: Loaded<PriceListScreen>;
  result: string | null;
}

// 16.12 /pricing/book: a price list in the manner of a hosting control panel. For each family, every
// product with its AWS base cost, the rate, the margin, the commission and the price the customer pays
// (all computed by the pricing engine, never stored), a live preview, and the start of each setting with
// its history. The save buttons exist only under a good preview.
export function PriceBookView({ locale, screen, result }: PriceBookViewProps) {
  const t = useTranslations("AdminPriceBook");
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
          {screen.value.edit === null ? null : (
            <EditCard locale={locale} screen={screen.value} edit={screen.value.edit} />
          )}
          {screen.value.families.map((family) => (
            <FamilyCard key={family.family} locale={locale} screen={screen.value} family={family} />
          ))}
        </>
      )}
    </>
  );
}
