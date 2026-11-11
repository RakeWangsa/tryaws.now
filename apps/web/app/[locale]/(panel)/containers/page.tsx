import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadContainerList } from "../../../../server/container-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { ContainersContent } from "./ContainersContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Containers.meta.title"), robots: { index: false, follow: false } };
}

/** /containers (16.10): the customer's container services. */
export default async function ContainersPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/containers");
  const screen = await loadContainerList(panel.session);
  return (
    <PanelFrame locale={locale} path="/containers" currentId="containers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Containers.heading")}</h1>
      <ContainersContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
