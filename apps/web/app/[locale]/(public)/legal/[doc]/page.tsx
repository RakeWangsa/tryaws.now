import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLegalDoc } from "../../../../../server/public/indexing.ts";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../../server/public/load.ts";
import { pageMetadata } from "../../../../../server/public/seo.ts";
import { PublicFrame } from "../../_components/PublicFrame.tsx";
import { localeOf, menuOf } from "../../_components/page.ts";
import { LegalContent } from "../LegalContent.tsx";

type Props = { params: Promise<{ locale: string; doc: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { doc } = await params;
  if (!isLegalDoc(doc)) notFound();
  const locale = await localeOf(params);
  const t = await getTranslations({ locale, namespace: "Public" });
  return pageMetadata({
    origin: publicOrigin(),
    locale,
    path: `/legal/${doc}`,
    title: t(`legal.docs.${doc}.title`),
    description: t("meta.legal.description"),
  });
}

/** `/legal/[doc]`: terms, privacy, acceptable use and refund. The text is a placeholder (WPP-T2). */
export default async function LegalPage({ params }: Props) {
  const { doc } = await params;
  if (!isLegalDoc(doc)) notFound();
  const locale = await localeOf(params);
  const [catalog, nonce] = await Promise.all([publicCatalog(), requestNonce()]);
  return (
    <PublicFrame locale={locale} path={`/legal/${doc}`} {...menuOf(catalog)}>
      <LegalContent locale={locale} doc={doc} origin={publicOrigin()} nonce={nonce} />
    </PublicFrame>
  );
}
