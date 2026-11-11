import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDatabaseDetail } from "../../../../../server/databases-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { destroyDatabaseAction, setDatabaseRunningAction } from "./actions.ts";
import { revealDatabasePasswordAction } from "./access-actions.ts";
import { DatabaseDetailContent } from "./DatabaseDetailContent.tsx";

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
  const tab = one(query["tab"]);
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
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}
