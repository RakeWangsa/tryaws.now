import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { loadServers } from "../../../../server/servers-view.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { ServersContent } from "./ServersContent.tsx";
import { ServersSubnav } from "./ServersSubnav.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Servers.meta.title"), robots: { index: false, follow: false } };
}

/** /servers (16.10): the customer's Cloud Servers. */
export default async function ServersPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/servers");
  const screen = await loadServers(panel.session);
  return (
    <PanelFrame locale={locale} path="/servers" currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-3">{t("Servers.heading")}</h1>
      <ServersSubnav locale={locale} current="servers" />
      <ServersContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
