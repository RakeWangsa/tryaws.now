import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadZone, pickEditing } from "../../../../../server/dns-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { deleteRecordAction, destroyDnsZoneAction, saveRecordAction } from "./actions.ts";
import { ZoneContent } from "./ZoneContent.tsx";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Dns.meta.detailTitle"), robots: { index: false, follow: false } };
}

/** /dns/[id] (WPU-G4). The id of another customer's zone answers like a missing one (R8). */
export default async function DnsZonePage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const edit = Array.isArray(query["edit"]) ? query["edit"][0] : query["edit"];
  const path = `/dns/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const screen = await loadZone(panel.session, id, newUuidV7());
  const editing =
    screen !== null && screen.state === "ready" ? pickEditing(screen.zone, edit) : null;
  return (
    <PanelFrame locale={locale} path={path} currentId="domains" panel={panel}>
      <ZoneContent
        locale={locale}
        screen={screen}
        editing={editing}
        saveAction={saveRecordAction}
        deleteAction={deleteRecordAction}
        destroyAction={destroyDnsZoneAction}
      />
    </PanelFrame>
  );
}
