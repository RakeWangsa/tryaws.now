import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDiskRestore } from "../../../../../server/disk-restore-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { restoreDiskAction } from "../[id]/actions.ts";
import { DiskRestoreContent } from "./DiskRestoreContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("DiskRestore.meta.title"), robots: { index: false, follow: false } };
}

/**
 * /servers/disk-restore (WPU-X2): a new disk from a snapshot of one of the customer's disks. Behind the
 * flag `disk`: with it off the page shows the flag-off state and lists nothing (R12). The action is
 * restoreDiskAction, which follows R9 and checks the snapshot against the customer's rows (R8).
 */
export default async function DiskRestorePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/servers/disk-restore");
  const screen = await loadDiskRestore(panel.session);
  return (
    <PanelFrame locale={locale} path="/servers/disk-restore" currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("DiskRestore.heading")}</h1>
      <DiskRestoreContent screen={screen} action={restoreDiskAction} />
    </PanelFrame>
  );
}
