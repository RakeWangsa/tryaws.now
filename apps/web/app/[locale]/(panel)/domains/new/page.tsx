import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadDomainOrder } from "../../../../../server/domain-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { createDomainDraftAction } from "./actions.ts";
import { DomainOrderContent } from "./DomainOrderContent.tsx";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Domains.new.meta.title"), robots: { index: false, follow: false } };
}

/** /domains/new?name= (16.10, 16.11 step 1): the contact form and the typed confirmation. */
export default async function NewDomainPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const query = await searchParams;
  const name = Array.isArray(query["name"]) ? query["name"][0] : query["name"];
  const panel = await startPanelPage("/domains/new");
  const screen = await loadDomainOrder(panel.session, name, () => new Date());
  return (
    <PanelFrame locale={locale} path="/domains/new" currentId="domains" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Domains.new.heading")}</h1>
      <DomainOrderContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        screen={screen}
        action={createDomainDraftAction}
      />
    </PanelFrame>
  );
}
