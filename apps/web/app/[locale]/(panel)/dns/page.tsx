import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadZoneList } from "../../../../server/dns-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { createDnsZoneDraftAction } from "./actions.ts";
import { DnsContent } from "./DnsContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Dns.meta.title"), robots: { index: false, follow: false } };
}

/** /dns (WPU-G4, WPU-G6): the DNS zones of the customer and the form that makes one. The nav entry is Domains (flag dns_zone, 16.7). */
export default async function DnsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/dns");
  const screen = await loadZoneList(panel.session);
  return (
    <PanelFrame locale={locale} path="/dns" currentId="domains" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Dns.heading")}</h1>
      <DnsContent locale={locale} screen={screen} createAction={createDnsZoneDraftAction} />
    </PanelFrame>
  );
}
