import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadCdnDetail } from "../../../../../server/cdn-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { CdnDetailContent } from "./CdnDetailContent.tsx";
import { destroyCdnAction, setCdnEnabledAction } from "./actions.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Cdn.detail.meta.title"), robots: { index: false, follow: false } };
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** /cdn/[id] (16.10): header and tabs. The id of another customer's CDN answers like a missing one (R8). */
export default async function CdnDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/cdn/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const cdn = await loadCdnDetail(panel.session, id);
  const tab = one(query["tab"]);
  return (
    <PanelFrame locale={locale} path={path} currentId="cdn" panel={panel}>
      <CdnDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        cdn={cdn}
        requestId={newUuidV7()}
        enabledAction={setCdnEnabledAction}
        destroyAction={destroyCdnAction}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}
