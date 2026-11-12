import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadSupport } from "../../../../../server/support-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { createSupportRequestAction } from "./actions.ts";
import { SupportContent } from "./SupportContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("SupportForm.meta.title"), robots: { index: false, follow: false } };
}

/** /support/new (16.10, /support when signed in): the request form and the customer's own requests. */
export default async function SupportNewPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/support/new");
  const screen = await loadSupport(panel.session);
  return (
    <PanelFrame locale={locale} path="/support/new" currentId="support" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("SupportForm.heading")}</h1>
      <SupportContent
        numerals={numeralsFor(locale, panel)}
        requests={screen.requests}
        resources={screen.resources}
        action={createSupportRequestAction}
      />
    </PanelFrame>
  );
}
