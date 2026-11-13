import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDiskList } from "../../../../../server/disk-list-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { setDiskAutoRenewAction } from "../../_family/auto-renew-actions.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { destroyDiskAction, detachDiskAction } from "../[id]/actions.ts";
import { DiskListContent } from "./DiskListContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("DiskList.meta.title"), robots: { index: false, follow: false } };
}

// The existing disk actions of the Storage tab; each follows R9 and checks the disk against the customer's rows (R8).
const actions = {
  detachDisk: detachDiskAction,
  destroyDisk: destroyDiskAction,
  setDiskAutoRenew: setDiskAutoRenewAction,
};

/**
 * /servers/disks (WPU-Y4): every block storage disk of the customer, any state, any Region, attached or not, with
 * the auto-renew switch and the disk actions, so a detached disk is never out of reach. Shown to every customer
 * whatever the server flag; each action follows its own flag (R12).
 */
export default async function DiskListPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/servers/disks");
  const screen = await loadDiskList(panel.session, newUuidV7());
  return (
    <PanelFrame locale={locale} path="/servers/disks" currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("DiskList.heading")}</h1>
      <DiskListContent locale={locale} screen={screen} actions={actions} />
    </PanelFrame>
  );
}
