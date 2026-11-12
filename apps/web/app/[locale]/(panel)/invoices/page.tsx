import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadInvoiceList } from "../../../../server/invoice-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { InvoicesContent } from "./InvoicesContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Invoices.meta.title"), robots: { index: false, follow: false } };
}

/** /invoices (WPU-G4): the invoices of the customer, keyset paging by (fiscal year, number). */
export default async function InvoicesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const query = await searchParams;
  const after = Array.isArray(query["after"]) ? query["after"][0] : query["after"];
  const panel = await startPanelPage("/invoices");
  const screen = await loadInvoiceList(panel.session, after);
  return (
    <PanelFrame locale={locale} path="/invoices" currentId="invoices" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Invoices.heading")}</h1>
      <InvoicesContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        hasCursor={after !== undefined && after !== ""}
      />
    </PanelFrame>
  );
}
