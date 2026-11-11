import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadServerDetail } from "../../../../../server/servers-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { ServerDetailContent } from "./ServerDetailContent.tsx";
import { revealWindowsPasswordAction } from "./windows-actions.ts";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Servers.detail.meta.title"), robots: { index: false, follow: false } };
}

/** /servers/[id] (16.10): header and tabs. The id of another customer's server answers like a missing one (R8). */
export default async function ServerDetailPage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage(`/servers/${encodeURIComponent(id)}`);
  const server = await loadServerDetail(panel.session, id);
  return (
    <PanelFrame
      locale={locale}
      path={`/servers/${encodeURIComponent(id)}`}
      currentId="cloudServers"
      panel={panel}
    >
      <ServerDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        server={server}
        windowsAction={revealWindowsPasswordAction}
      />
    </PanelFrame>
  );
}
