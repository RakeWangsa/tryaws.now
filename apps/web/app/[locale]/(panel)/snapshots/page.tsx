import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadSnapshots } from "../../../../server/account-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import {
  createBackupAction,
  deleteBackupAction,
  restoreToNewServerAction,
} from "../servers/[id]/actions.ts";
import { SnapshotsContent } from "./SnapshotsContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Snapshots.meta.title"), robots: { index: false, follow: false } };
}

/**
 * /snapshots (WPU-G5): the snapshots of all the customer's servers. The actions are those of the
 * server page; each one follows R9 and checks the ownership of the server or snapshot again (R8).
 */
export default async function SnapshotsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage("/snapshots");
  const screen = await loadSnapshots(panel.session, newUuidV7());
  return (
    <PanelFrame locale={locale} path="/snapshots" currentId="cloudServers" panel={panel}>
      <SnapshotsContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        actions={{
          createBackup: createBackupAction,
          deleteBackup: deleteBackupAction,
          restoreToNewServer: restoreToNewServerAction,
        }}
      />
    </PanelFrame>
  );
}
