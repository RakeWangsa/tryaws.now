import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadConfigurator } from "../../../../../server/servers-view.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createOrderDraftAction } from "./actions.ts";
import { ConfiguratorContent } from "./ConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Servers.new.meta.title"), robots: { index: false, follow: false } };
}

/** /servers/new (16.10, 16.11 step 1): the catalog rows the customer may buy, priced on the server. */
export default async function NewServerPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/servers/new");
  const screen = await loadConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/servers/new" currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Servers.new.heading")}</h1>
      <ConfiguratorContent locale={locale} screen={screen} action={createOrderDraftAction} />
    </PanelFrame>
  );
}
