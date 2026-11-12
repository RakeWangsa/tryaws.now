import { Button, Card, DataTable, DateText, EmptyState, MoneyText } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { InvoiceDetailScreen, InvoiceLineView } from "../../../../../server/invoice-view.ts";

// The content of /invoices/[id] (WPU-G4): the number, the date, who is billed, the lines and the total.
// An invoice of another customer and a missing one give the same answer (R8). The total is printed
// only when the lines add up to it (R16): loadInvoice answers "unavailable" otherwise. The printable
// document is the same HTML that becomes the PDF (invoice-renderer); the browser prints it or saves it
// as a PDF. Synchronous, so it renders in a test without a request.

type Numerals = "beng" | "latn";

export function InvoiceDetailContent({
  locale,
  numerals,
  screen,
  customerName,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: InvoiceDetailScreen | null;
  customerName: string;
}) {
  const t = useTranslations("Invoices");
  const listHref = localePath(locale, "/invoices");

  if (screen === null) {
    return (
      <EmptyState
        title={t("detail.notFound.title")}
        description={t("detail.notFound.body")}
        action={
          <Button variant="primary" href={listHref}>
            {t("detail.back")}
          </Button>
        }
      />
    );
  }
  if (screen.state === "unavailable") {
    return (
      <EmptyState
        title={t("detail.unavailable.title")}
        description={t("detail.unavailable.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/support")}>
            {t("detail.unavailable.action")}
          </Button>
        }
      />
    );
  }

  // No complete seller details: no tax invoice is shown or printed (R16, WPU-I1).
  if (screen.state === "seller_missing") {
    return (
      <EmptyState
        title={t("detail.sellerMissing.title")}
        description={t("detail.sellerMissing.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/support")}>
            {t("detail.sellerMissing.action")}
          </Button>
        }
      />
    );
  }

  const { invoice } = screen;
  return (
    <>
      <p className="mb-3">
        <a href={listHref}>
          <i className="fas fa-arrow-left me-1" aria-hidden="true" />
          {t("detail.back")}
        </a>
      </p>
      <h1 className="h3 mergecolor mb-4">{t("detail.title", { number: invoice.number })}</h1>
      <Card className="mb-4">
        <div className="row g-3">
          <div className="col-12 col-md-4">
            <p className="seccolor mb-1">{t("detail.number")}</p>
            <b className="mergecolor">{invoice.number}</b>
          </div>
          <div className="col-12 col-md-4">
            <p className="seccolor mb-1">{t("detail.date")}</p>
            <b className="mergecolor">
              <DateText value={invoice.issuedAt} numerals={numerals} />
            </b>
          </div>
          <div className="col-12 col-md-4">
            <p className="seccolor mb-1">{t("detail.billedTo")}</p>
            <b className="mergecolor">{customerName === "" ? t("detail.noName") : customerName}</b>
          </div>
        </div>
      </Card>
      <DataTable
        caption={t("detail.lines.caption")}
        rows={invoice.lines}
        rowKey={(line) => `${line.kind}:${line.code}`}
        columns={[
          {
            key: "description",
            header: t("detail.lines.description"),
            cell: (line: InvoiceLineView) => line.label[locale],
          },
          {
            key: "amount",
            header: t("detail.lines.amount"),
            cell: (line: InvoiceLineView) => (
              <MoneyText minor={line.amountMinor} mode="exact" numerals={numerals} />
            ),
          },
        ]}
      />
      <p className="mt-3 mb-4 text-end">
        <span className="seccolor me-2">{t("detail.lines.total")}</span>
        <b className="mergecolor h4">
          <MoneyText minor={invoice.totalMinor} mode="exact" numerals={numerals} />
        </b>
      </p>
      <p className="mb-1">
        <a
          className="btn btn-default-yellow-fill"
          href={localePath(locale, `/invoices/${encodeURIComponent(invoice.id)}/document`)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <i className="fas fa-print me-2" aria-hidden="true" />
          {t("detail.print")}
        </a>
      </p>
      <p className="seccolor small mb-1">{t("detail.printHint")}</p>
      <p className="seccolor small">{t("detail.mushakHint")}</p>
    </>
  );
}
