import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDatabaseDetail } from "../../../../../server/databases-view.ts";
import { rangeOf } from "../../../../../server/extras-view.ts";
import { getReaderPort } from "../../../../../server/reader-port.ts";
import { loadDatabaseMetrics } from "../../../../../server/reader-reads-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadAutoRenew } from "../../../../../server/auto-renew-view.ts";
import { AutoRenewSwitch } from "../../_family/AutoRenewSwitch.tsx";
import { setDatabaseAutoRenewAction } from "../../_family/auto-renew-actions.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import {
  destroyDatabaseAction,
  readDatabaseParametersAction,
  rebootDatabaseAction,
  setDatabaseOptionsAction,
  setDatabaseParametersAction,
  setDatabaseRunningAction,
} from "./actions.ts";
import { revealDatabasePasswordAction } from "./access-actions.ts";
import {
  createDbSnapshotAction,
  deleteDbSnapshotAction,
  restoreDatabasePointInTimeAction,
  restoreDatabaseSnapshotAction,
} from "./snapshot-actions.ts";
import { DatabaseOptionsForm } from "../../_console/ConsoleForms.tsx";
import { DatabaseParameters } from "../../_console/DatabaseParameters.tsx";
import { DatabaseDetailContent } from "./DatabaseDetailContent.tsx";
import { DatabaseMetricsTab } from "./DatabaseMetricsTab.tsx";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Databases.detail.meta.title"), robots: { index: false, follow: false } };
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** /databases/[id] (16.10): header and tabs. The id of another customer's database answers like a missing one (R8). */
export default async function DatabaseDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/databases/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const database = await loadDatabaseDetail(panel.session, id);
  // WPU-Z14: the auto-renew switch of the Overview tab (null: no own row, no subscription, flag off).
  const renew = database === null ? null : await loadAutoRenew(panel.session, "database", id);
  const tab = one(query["tab"]);
  // WPU-Y8: read once on page load (the tabs are all rendered; no timer, no polling).
  const metricsScreen =
    database !== null
      ? await loadDatabaseMetrics(
          panel.session,
          database.id,
          rangeOf(one(query["range"])),
          await getReaderPort(),
        )
      : ({ state: "empty", range: rangeOf(one(query["range"])) } as const);
  return (
    <PanelFrame locale={locale} path={path} currentId="databases" panel={panel}>
      <DatabaseDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        database={database}
        requestId={newUuidV7()}
        runningAction={setDatabaseRunningAction}
        destroyAction={destroyDatabaseAction}
        revealAction={revealDatabasePasswordAction}
        snapshots={{
          requestIds: { create: newUuidV7(), delete: newUuidV7() },
          create: createDbSnapshotAction,
          delete: deleteDbSnapshotAction,
          restore: restoreDatabaseSnapshotAction,
          pitr: restoreDatabasePointInTimeAction,
        }}
        {...(database !== null && database.state === "active"
          ? {
              extra: (
                <DatabaseOptionsForm
                  action={setDatabaseOptionsAction}
                  databaseId={database.id}
                  requestId={newUuidV7()}
                  console={
                    database.console ?? {
                      parameters: null,
                      backupWindow: null,
                      maintenanceWindow: null,
                      publiclyAccessible: false,
                    }
                  }
                />
              ),
            }
          : {})}
        {...(database !== null
          ? {
              metricsTab: (
                <DatabaseMetricsTab
                  databaseId={database.id}
                  screen={metricsScreen}
                  locale={locale}
                  numerals={numeralsFor(locale, panel)}
                />
              ),
            }
          : {})}
        {...(database !== null
          ? {
              parametersTab: (
                <DatabaseParameters
                  saveAction={setDatabaseParametersAction}
                  readAction={readDatabaseParametersAction}
                  rebootAction={rebootDatabaseAction}
                  databaseId={database.id}
                  saveRequestId={newUuidV7()}
                  readRequestId={newUuidV7()}
                  rebootRequestId={newUuidV7()}
                  facts={database.console?.parameters ?? null}
                  numerals={numeralsFor(locale, panel)}
                  allowed={database.state === "active"}
                />
              ),
            }
          : {})}
        {...(renew !== null
          ? { renewal: <AutoRenewSwitch action={setDatabaseAutoRenewAction} view={renew} /> }
          : {})}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}
