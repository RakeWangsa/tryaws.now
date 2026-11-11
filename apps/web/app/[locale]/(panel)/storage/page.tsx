import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadBucketList } from "../../../../server/bucket-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { StorageContent } from "./StorageContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Storage.meta.title"), robots: { index: false, follow: false } };
}

/** /storage (16.10): the customer's object storage buckets. */
export default async function StoragePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/storage");
  const screen = await loadBucketList(panel.session);
  return (
    <PanelFrame locale={locale} path="/storage" currentId="objectStorage" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Storage.heading")}</h1>
      <StorageContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
