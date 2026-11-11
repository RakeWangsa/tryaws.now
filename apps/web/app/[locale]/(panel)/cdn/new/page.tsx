import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadCdnConfigurator } from "../../../../../server/cdn-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createCdnDraftAction } from "./actions.ts";
import { CdnConfiguratorContent } from "./CdnConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Cdn.new.meta.title"), robots: { index: false, follow: false } };
}

/** /cdn/new (16.10, 16.11 step 1): the catalog rows the customer may buy, priced on the server. */
export default async function NewCdnPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/cdn/new");
  const screen = await loadCdnConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/cdn/new" currentId="cdn" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Cdn.new.heading")}</h1>
      <CdnConfiguratorContent locale={locale} screen={screen} action={createCdnDraftAction} />
    </PanelFrame>
  );
}
