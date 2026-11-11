import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadCdnList } from "../../../../server/cdn-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { CdnContent } from "./CdnContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Cdn.meta.title"), robots: { index: false, follow: false } };
}

/** /cdn (16.10): the customer's CDN distributions. */
export default async function CdnPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/cdn");
  const screen = await loadCdnList(panel.session);
  return (
    <PanelFrame locale={locale} path="/cdn" currentId="cdn" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Cdn.heading")}</h1>
      <CdnContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
