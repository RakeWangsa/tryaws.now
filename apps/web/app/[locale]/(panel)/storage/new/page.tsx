import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadBucketConfigurator } from "../../../../../server/bucket-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createBucketDraftAction } from "./actions.ts";
import { StorageConfiguratorContent } from "./StorageConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Storage.new.meta.title"), robots: { index: false, follow: false } };
}

/** /storage/new (16.10, 16.11 step 1): the catalog rows the customer may buy, priced on the server. */
export default async function NewBucketPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/storage/new");
  const screen = await loadBucketConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/storage/new" currentId="objectStorage" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Storage.new.heading")}</h1>
      <StorageConfiguratorContent
        locale={locale}
        screen={screen}
        action={createBucketDraftAction}
      />
    </PanelFrame>
  );
}
