import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState, PublicShell } from "@tc/ui";
import { localeHrefs } from "@tc/ui/runtime";
import { routing } from "../../i18n/routing.ts";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return {
    title: t("Web.meta.title"),
    description: t("Web.meta.description"),
    icons: { icon: "/brand/symbol.svg" },
  };
}

/** The coming-soon page: the public frame around one sentence (the structure of 404.html). */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return (
    <PublicShell
      locale={locale}
      localeHrefs={localeHrefs("/")}
      signedIn={false}
      openFamilies={[]}
      domainsOpen={false}
      announcement={t("Web.announcement")}
      supportPhone={null}
    >
      <EmptyState fullPage title={t("Web.home.title")} description={t("Aws.short")} />
    </PublicShell>
  );
}
