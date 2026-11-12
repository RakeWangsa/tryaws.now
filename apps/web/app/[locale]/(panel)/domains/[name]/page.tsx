import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDomainDetail } from "../../../../../server/domain-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { setDomainAutoRenewAction } from "./actions.ts";
import { DomainDetailContent } from "./DomainDetailContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; name: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Domains.detail.meta.title"), robots: { index: false, follow: false } };
}

/** /domains/[name] (16.10). The name of another customer's domain answers like a missing one (R8). */
export default async function DomainDetailPage({ params }: Props) {
  const { locale, name } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const path = `/domains/${encodeURIComponent(name)}`;
  const panel = await startPanelPage(path);
  const domain = await loadDomainDetail(panel.session, decodeURIComponent(name));
  return (
    <PanelFrame locale={locale} path={path} currentId="domains" panel={panel}>
      <DomainDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        domain={domain}
        requestId={newUuidV7()}
        renewAction={setDomainAutoRenewAction}
      />
    </PanelFrame>
  );
}
