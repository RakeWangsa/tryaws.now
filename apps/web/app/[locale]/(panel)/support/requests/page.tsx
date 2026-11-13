import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadSupportRequests } from "../../../../../server/support-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { RequestsContent } from "./RequestsContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("SupportRequests.meta.title"), robots: { index: false, follow: false } };
}

/** /support/requests (WPU-Z6): the customer's support requests, the newest activity first. */
export default async function SupportRequestsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/support/requests");
  const screen = await loadSupportRequests(panel.session);
  return (
    <PanelFrame locale={locale} path="/support/requests" currentId="support" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("SupportRequests.heading")}</h1>
      <RequestsContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        requests={screen.requests}
      />
    </PanelFrame>
  );
}
