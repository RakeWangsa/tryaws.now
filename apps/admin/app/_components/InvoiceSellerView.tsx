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
import { localePath, type Locale } from "@tc/ui/runtime";
import { saveInvoiceSellerAction } from "../../server/pricing-actions.ts";
import type { Loaded } from "../../server/pricing-data.ts";
import type { InvoiceSellerScreen, SellerHistoryLine } from "../../server/invoice-seller-data.ts";

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
  const t = useTranslations("AdminInvoiceSeller.result");
  if (code === null) return null;
  const good = code === "ok" || code === "replayed";
  return (
    <p role={good ? "status" : "alert"} className="form-text seccolor mb-3">
      {t(code)}
    </p>
  );
}

function MarketForm({ locale, screen }: { locale: Locale; screen: InvoiceSellerScreen }) {
  const t = useTranslations("AdminInvoiceSeller.market");
  return (
    <form method="get" action={localePath(locale, "/pricing/seller")} className="mb-3">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="seller-market">
          {t("label")}
        </label>
        <select
          id="seller-market"
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

function Status({ screen }: { screen: InvoiceSellerScreen }) {
  const t = useTranslations("AdminInvoiceSeller");
  return (
    <Card title={t("status.title")}>
      <p className="mb-2">
        <Badge tone={screen.state === "ready" ? "purple" : "grey"}>
          {t(`status.${screen.state}`)}
        </Badge>
        {screen.version === null ? null : (
          <span className="ms-2 seccolor">{t("status.version", { version: screen.version })}</span>
        )}
      </p>
      {screen.state === "ready" ? null : <p role="alert">{t(`notice.${screen.state}`)}</p>}
    </Card>
  );
}

function Editor({ locale, screen }: { locale: Locale; screen: InvoiceSellerScreen }) {
  const t = useTranslations("AdminInvoiceSeller.form");
  const s = screen.seller;
  // The form opens on the saved values; with none saved it is empty (nothing is prefilled).
  const text = (v: string | undefined): string => v ?? "";
  return (
    <form action={saveInvoiceSellerAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="market" value={screen.market} />
      <FormBlock>
        <Field
          name="legalNameBn"
          id="seller-legalNameBn"
          label={t("legalNameBn")}
          required
          defaultValue={text(s?.legalNameBn)}
          maxLength={200}
          autoComplete="off"
        />
        <Field
          name="legalNameEn"
          id="seller-legalNameEn"
          label={t("legalNameEn")}
          required
          defaultValue={text(s?.legalNameEn)}
          maxLength={200}
          autoComplete="off"
        />
        <Field
          name="bin"
          id="seller-bin"
          label={t("bin")}
          hint={t("binHint")}
          required
          defaultValue={text(s?.bin)}
          maxLength={13}
          autoComplete="off"
          inputMode="numeric"
        />
        <Field
          name="addressBn"
          id="seller-addressBn"
          label={t("addressBn")}
          required
          defaultValue={text(s?.addressBn)}
          maxLength={400}
          autoComplete="off"
        />
        <Field
          name="addressEn"
          id="seller-addressEn"
          label={t("addressEn")}
          required
          defaultValue={text(s?.addressEn)}
          maxLength={400}
          autoComplete="off"
        />
        <Field
          name="vatCircle"
          id="seller-vatCircle"
          label={t("vatCircle")}
          defaultValue={text(s?.vatCircle)}
          maxLength={200}
          autoComplete="off"
        />
        <Field
          name="signatoryName"
          id="seller-signatoryName"
          label={t("signatoryName")}
          required
          defaultValue={text(s?.signatoryName)}
          maxLength={120}
          autoComplete="off"
        />
        <Field
          name="signatoryDesignation"
          id="seller-signatoryDesignation"
          label={t("signatoryDesignation")}
          required
          defaultValue={text(s?.signatoryDesignation)}
          maxLength={120}
          autoComplete="off"
        />
        <Field
          name="phone"
          id="seller-phone"
          label={t("phone")}
          defaultValue={text(s?.phone)}
          maxLength={20}
          autoComplete="off"
          inputMode="tel"
        />
        <Field
          name="email"
          id="seller-email"
          label={t("email")}
          defaultValue={text(s?.email)}
          maxLength={120}
          autoComplete="off"
          inputMode="email"
        />
        <Field
          name="reason"
          id="seller-reason"
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

function History({ screen }: { screen: InvoiceSellerScreen }) {
  const t = useTranslations("AdminInvoiceSeller.history");
  const columns: DataTableColumn<SellerHistoryLine>[] = [
    {
      key: "when",
      header: t("when"),
      cell: (l) => <DateText value={l.row.createdAt} variant="datetime" />,
    },
    {
      key: "who",
      header: t("by"),
      cell: (l) => (l.row.actorId === null ? "-" : `#${l.row.actorId.slice(0, 8)}`),
    },
    {
      key: "change",
      header: t("change"),
      cell: (l) => (l.changed.length === 0 ? "-" : l.changed.join(", ")),
    },
    { key: "reason", header: t("reason"), cell: (l) => l.row.reason ?? "-" },
  ];
  return (
    <Card title={t("title")}>
      {screen.history.length === 0 ? (
        <EmptyState title={t("empty")} description="" />
      ) : (
        <DataTable
          caption={t("caption")}
          columns={columns}
          rows={[...screen.history]}
          rowKey={(l) => l.row.id}
        />
      )}
    </Card>
  );
}

export interface InvoiceSellerViewProps {
  locale: Locale;
  screen: Loaded<InvoiceSellerScreen>;
  result: string | null;
}

// 16.12 /pricing/seller: the legal details of the seller on the tax invoices (Mushak 6.3). Without complete
// details no invoice is issued or printed (fail closed). Nothing is prefilled; the owner types the values.
export function InvoiceSellerView({ locale, screen, result }: InvoiceSellerViewProps) {
  const t = useTranslations("AdminInvoiceSeller");
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
          <Card>
            <MarketForm locale={locale} screen={screen.value} />
          </Card>
          <Status screen={screen.value} />
          <Card title={t("current.title")}>
            <Editor locale={locale} screen={screen.value} />
          </Card>
          <History screen={screen.value} />
        </>
      )}
    </>
  );
}
