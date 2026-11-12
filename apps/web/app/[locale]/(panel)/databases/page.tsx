import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadDatabaseList } from "../../../../server/databases-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { DatabasesContent } from "./DatabasesContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Databases.meta.title"), robots: { index: false, follow: false } };
}

/** /databases (16.10): the customer's managed databases. */
export default async function DatabasesPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/databases");
  const screen = await loadDatabaseList(panel.session);
  return (
    <PanelFrame locale={locale} path="/databases" currentId="databases" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Databases.heading")}</h1>
      <DatabasesContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
