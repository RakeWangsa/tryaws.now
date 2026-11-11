import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDatabaseConfigurator } from "../../../../../server/databases-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createDatabaseDraftAction } from "./actions.ts";
import { DatabaseConfiguratorContent } from "./DatabaseConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Databases.new.meta.title"), robots: { index: false, follow: false } };
}

/** /databases/new (16.10, 16.11 step 1): the catalog rows the customer may buy, priced on the server. */
export default async function NewDatabasePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/databases/new");
  const screen = await loadDatabaseConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/databases/new" currentId="databases" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Databases.new.heading")}</h1>
      <DatabaseConfiguratorContent
        locale={locale}
        screen={screen}
        action={createDatabaseDraftAction}
      />
    </PanelFrame>
  );
}
