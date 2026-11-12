import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { localePath } from "@tc/ui/runtime";
import { routing } from "../../../../i18n/routing.ts";
import { domainSearchPort } from "../../../../server/domain-deps.ts";
import { loadDomainList, loadDomainSearch } from "../../../../server/domain-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { DomainsContent } from "./DomainsContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Domains.meta.title"), robots: { index: false, follow: false } };
}

/** /domains (16.10): search with availability and price, and the customer's domains. */
export default async function DomainsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const query = await searchParams;
  const q = Array.isArray(query["q"]) ? query["q"][0] : query["q"];
  const panel = await startPanelPage("/domains");
  const [search, list] = await Promise.all([
    loadDomainSearch(panel.session, q, domainSearchPort(), () => new Date()),
    loadDomainList(panel.session),
  ]);
  return (
    <PanelFrame locale={locale} path="/domains" currentId="domains" panel={panel}>
      <h1 className="h3 mergecolor mb-3">{t("Domains.heading")}</h1>
      <p className="mb-4">
        <a href={localePath(locale, "/dns")}>
          <i className="fas fa-sitemap me-1" aria-hidden="true" />
          {t("Domains.dnsLink")}
        </a>
      </p>
      <DomainsContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        search={search}
        list={list}
        {...(q !== undefined ? { query: q } : {})}
      />
    </PanelFrame>
  );
}
