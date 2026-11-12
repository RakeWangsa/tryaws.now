import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadStaticIps } from "../../../../server/account-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { attachStaticIpAction, detachStaticIpAction } from "../servers/[id]/manage-actions.ts";
import { StaticIpsContent } from "./StaticIpsContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("StaticIps.meta.title"), robots: { index: false, follow: false } };
}

/**
 * /static-ips (WPU-G5): the static IP of each server. The actions are those of the Networking tab
 * (attach and detach); each one follows R9 and checks the ownership of the server again (R8).
 */
export default async function StaticIpsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage("/static-ips");
  const screen = await loadStaticIps(panel.session, newUuidV7());
  return (
    <PanelFrame locale={locale} path="/static-ips" currentId="cloudServers" panel={panel}>
      <StaticIpsContent
        locale={locale}
        screen={screen}
        actions={{ attachIp: attachStaticIpAction, detachIp: detachStaticIpAction }}
      />
    </PanelFrame>
  );
}
