import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadInvoice } from "../../../../../server/invoice-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { InvoiceDetailContent } from "./InvoiceDetailContent.tsx";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ pdf?: string | string[] }>;
};

const PDF_NOTICES = ["unavailable", "not_ready", "busy"] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Invoices.meta.title"), robots: { index: false, follow: false } };
}

/** /invoices/[id] (WPU-G4). The id of another customer's invoice answers like a missing one (R8). */
export default async function InvoiceDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  const { pdf } = await searchParams;
  const pdfNotice = PDF_NOTICES.find((n) => n === pdf) ?? null;
  if (!hasLocale(routing.locales, locale)) notFound();
  const path = `/invoices/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const screen = await loadInvoice(panel.session, id);
  return (
    <PanelFrame locale={locale} path={path} currentId="invoices" panel={panel}>
      <InvoiceDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        customerName={panel.displayName}
        pdfNotice={pdfNotice}
      />
    </PanelFrame>
  );
}
