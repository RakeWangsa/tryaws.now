import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadContainerConfigurator } from "../../../../../server/container-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createContainerDraftAction } from "./actions.ts";
import { ContainerConfiguratorContent } from "./ContainerConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Containers.new.meta.title"), robots: { index: false, follow: false } };
}

/** /containers/new (16.10, 16.11 step 1): the catalog rows the customer may buy, priced on the server. */
export default async function NewContainerPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/containers/new");
  const screen = await loadContainerConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/containers/new" currentId="containers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Containers.new.heading")}</h1>
      <ContainerConfiguratorContent
        locale={locale}
        screen={screen}
        action={createContainerDraftAction}
      />
    </PanelFrame>
  );
}
