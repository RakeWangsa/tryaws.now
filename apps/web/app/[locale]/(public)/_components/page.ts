import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ProductFamily } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { routing } from "../../../../i18n/routing.ts";
import type { PublicCatalog } from "../../../../server/public/catalog.ts";
import { publicOrigin } from "../../../../server/public/load.ts";
import { pageMetadata } from "../../../../server/public/seo.ts";

// The small shared steps of the public pages: a locale from the route (anything but bn and en is a
// missing page, 16.7), the families of the menu from the catalog, and the metadata of a page.

export type LocaleParams = { params: Promise<{ locale: string }> };

export async function localeOf(params: LocaleParams["params"]): Promise<Locale> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return locale as Locale;
}

/** The families in the menu: those whose flag is on; none when the catalog cannot be read (R12, R16). */
export function menuOf(catalog: PublicCatalog): {
  openFamilies: readonly ProductFamily[];
  domainsOpen: boolean;
} {
  return catalog.state === "ok"
    ? { openFamilies: catalog.open, domainsOpen: catalog.domainsOpen }
    : { openFamilies: [], domainsOpen: false };
}

/** Metadata of a page from `Public.meta.<key>` (title and description name Amazon Lightsail, 16.8). */
export async function metadataOf(
  params: LocaleParams["params"],
  path: string,
  key: "home" | "pricing" | "cloudServers" | "help" | "support" | "legal",
): Promise<Metadata> {
  const locale = await localeOf(params);
  const t = await getTranslations({ locale, namespace: "Public.meta" });
  return pageMetadata({
    origin: publicOrigin(),
    locale,
    path,
    title: t(`${key}.title`),
    description: t(`${key}.description`),
  });
}
