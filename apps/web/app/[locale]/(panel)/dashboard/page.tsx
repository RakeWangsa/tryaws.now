import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadDashboard } from "../../../../server/extras-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { DashboardContent } from "./DashboardContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Dashboard.meta.title"), robots: { index: false, follow: false } };
}

/** /dashboard (16.10), completed in WP5-T6. Everything is read through the customer's repositories (R8). */
export default async function DashboardPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage("/dashboard");
  const view = await loadDashboard(panel.session, new Date());
  return (
    <PanelFrame locale={locale} path="/dashboard" currentId="dashboard" panel={panel}>
      <DashboardContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        view={view}
        flagOff={panel.enabledFamilies.length === 0}
      />
    </PanelFrame>
  );
}
