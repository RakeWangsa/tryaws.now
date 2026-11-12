import { Button, DataTable, DateText, EmptyState, MoneyText } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { InvoiceListItem, InvoiceListScreen } from "../../../../server/invoice-view.ts";

// The content of /invoices (WPU-G4): the invoices of the customer, newest first, 20 to a page. The
// table is the one of cart.html through the kit (rows become cards below 768 px). The number is a
// technical value in Latin digits (16.13); dates and amounts follow the panel's digits. Synchronous, so
// it renders in a test without a request.

type Numerals = "beng" | "latn";

export function InvoicesContent({
  locale,
  numerals,
  screen,
  hasCursor,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: InvoiceListScreen;
  hasCursor: boolean;
}) {
  const t = useTranslations("Invoices");
  const first = localePath(locale, "/invoices");

  if (screen.state === "empty" && !hasCursor) {
    return (
      <EmptyState
        title={t("empty.title")}
        description={t("empty.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/wallet")}>
            {t("empty.action")}
          </Button>
        }
      />
    );
  }
  // A cursor that leads to nothing (an old link): go back to the first page.
  if (screen.state === "empty") {
    return (
      <EmptyState
        title={t("empty.title")}
        description={t("empty.body")}
        action={
          <Button variant="primary" href={first}>
            {t("detail.back")}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <p className="seccolor mb-4">{t("intro")}</p>
      <DataTable
        caption={t("list.caption")}
        rows={screen.items}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "number",
            header: t("list.number"),
            cell: (row: InvoiceListItem) => (
              <>
                <a href={localePath(locale, `/invoices/${encodeURIComponent(row.id)}`)}>
                  {row.number}
                </a>
                {row.kind === "credit_note" ? (
                  <span className="seccolor small ms-2">{t("list.creditNote")}</span>
                ) : null}
              </>
            ),
          },
          {
            key: "date",
            header: t("list.date"),
            cell: (row: InvoiceListItem) => <DateText value={row.issuedAt} numerals={numerals} />,
          },
          {
            key: "total",
            header: t("list.total"),
            cell: (row: InvoiceListItem) => (
              <MoneyText minor={row.totalMinor} mode="exact" numerals={numerals} />
            ),
          },
          {
            key: "view",
            header: t("list.view"),
            cell: (row: InvoiceListItem) => (
              <Button
                variant="default"
                size="sm"
                href={localePath(locale, `/invoices/${encodeURIComponent(row.id)}`)}
              >
                {t("list.view")}
              </Button>
            ),
          },
        ]}
        {...(hasCursor || screen.next !== null
          ? {
              prevHref: hasCursor ? first : null,
              nextHref: screen.next === null ? null : `${first}?after=${screen.next}`,
            }
          : {})}
      />
    </>
  );
}
