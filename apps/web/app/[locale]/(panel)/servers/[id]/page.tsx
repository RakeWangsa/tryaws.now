import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadMetrics, loadServerExtras, rangeOf } from "../../../../../server/extras-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { getReaderPort } from "../../../../../server/reader-port.ts";
import { loadServerManage } from "../../../../../server/server-manage-view.ts";
import { loadServerDetail } from "../../../../../server/servers-view.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { ServerDetailContent } from "./ServerDetailContent.tsx";
import {
  addDiskAction,
  attachDiskAction,
  createBackupAction,
  deleteBackupAction,
  destroyDiskAction,
  destroyServerAction,
  detachDiskAction,
  renewNowAction,
  restoreToNewServerAction,
  setAutoBackupAction,
  setAutoRenewAction,
} from "./actions.ts";
import {
  addFirewallRuleAction,
  attachStaticIpAction,
  detachStaticIpAction,
  rebootServerAction,
  removeFirewallRuleAction,
  renameServerAction,
  startServerAction,
  stopServerAction,
} from "./manage-actions.ts";
import { revealWindowsPasswordAction } from "./windows-actions.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Servers.detail.meta.title"), robots: { index: false, follow: false } };
}

const actions = {
  createBackup: createBackupAction,
  deleteBackup: deleteBackupAction,
  setAutoBackup: setAutoBackupAction,
  addDisk: addDiskAction,
  attachDisk: attachDiskAction,
  detachDisk: detachDiskAction,
  destroyDisk: destroyDiskAction,
  setAutoRenew: setAutoRenewAction,
  renewNow: renewNowAction,
  restoreToNewServer: restoreToNewServerAction,
  destroyServer: destroyServerAction,
};

// WPU-G2: the header buttons, the rename and the Networking tab.
const manageActions = {
  reboot: rebootServerAction,
  stop: stopServerAction,
  start: startServerAction,
  rename: renameServerAction,
  addRule: addFirewallRuleAction,
  removeRule: removeFirewallRuleAction,
  attachIp: attachStaticIpAction,
  detachIp: detachStaticIpAction,
};

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * /servers/[id] (16.10): header and tabs. The id of another customer's server answers like a missing
 * one (R8). The tabs Backups, Storage, Metrics, Billing and Destroy (WP5-T6) are behind the flag of
 * the family; with the flag off the page keeps its first three tabs.
 */
export default async function ServerDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/servers/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const server = await loadServerDetail(panel.session, id);
  const screen = server === null ? null : await loadServerExtras(panel.session, id, newUuidV7());
  const extras =
    screen !== null && screen.state === "ready" && screen.extras !== null
      ? {
          data: screen.extras,
          metrics: await loadMetrics(
            panel.session,
            id,
            rangeOf(one(query["range"])),
            await getReaderPort(),
          ),
          actions,
        }
      : null;
  const managed = server === null ? null : await loadServerManage(panel.session, id, newUuidV7());
  const manage = managed === null ? null : { data: managed, actions: manageActions };
  const tab = one(query["tab"]);
  return (
    <PanelFrame locale={locale} path={path} currentId="cloudServers" panel={panel}>
      <ServerDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        server={server}
        extras={extras}
        manage={manage}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
        windowsAction={revealWindowsPasswordAction}
      />
    </PanelFrame>
  );
}
