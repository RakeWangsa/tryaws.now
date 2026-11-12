import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadBilling } from "../../../../server/account-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { BillingContent } from "./BillingContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Billing.meta.title"), robots: { index: false, follow: false } };
}

/** /billing (WPU-G5): what runs now, the cost of one term and the next renewal. Reads only. */
export default async function BillingPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage("/billing");
  const screen = await loadBilling(panel.session, new Date());
  return (
    <PanelFrame locale={locale} path="/billing" currentId="wallet" panel={panel}>
      <BillingContent locale={locale} numerals={numeralsFor(locale, panel)} screen={screen} />
    </PanelFrame>
  );
}
