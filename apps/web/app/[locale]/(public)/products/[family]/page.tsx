import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { familyPageOf } from "../../../../../server/public/indexing.ts";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../../server/public/load.ts";
import { pageMetadata } from "../../../../../server/public/seo.ts";
import { PublicFrame } from "../../_components/PublicFrame.tsx";
import { localeOf, menuOf } from "../../_components/page.ts";
import { FamilyContent } from "./FamilyContent.tsx";

type Props = { params: Promise<{ locale: string; family: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { family } = await params;
  const page = familyPageOf(family);
  if (page === null) notFound();
  const locale = await localeOf(params);
  const [t, catalog] = await Promise.all([
    getTranslations({ locale, namespace: "Public" }),
    publicCatalog(),
  ]);
  const open = catalog.state === "ok" && catalog.flagOn(page.flag);
  const name = t(`family.${page.nameKey}`);
  return pageMetadata({
    origin: publicOrigin(),
    locale,
    path: `/products/${page.slug}`,
    title: open ? name : t("soon.title", { name }),
    description: t("meta.soon.description"),
    // A coming soon page is thin: it is not offered to search engines until the family opens.
    index: open,
  });
}

/** `/products/[family]`: a flag-off family shows the coming soon page with "notify me" (WPP-T4, R12). */
export default async function FamilyPage({ params }: Props) {
  const { family } = await params;
  const page = familyPageOf(family);
  if (page === null) notFound();
  const locale = await localeOf(params);
  const [catalog, nonce] = await Promise.all([publicCatalog(), requestNonce()]);
  const open = catalog.state === "ok" && catalog.flagOn(page.flag);
  return (
    <PublicFrame locale={locale} path={`/products/${page.slug}`} {...menuOf(catalog)}>
      <FamilyContent
        locale={locale}
        page={page}
        open={open}
        origin={publicOrigin()}
        nonce={nonce}
      />
    </PublicFrame>
  );
}
