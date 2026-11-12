import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../server/public/load.ts";
import { PublicFrame } from "./(public)/_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "./(public)/_components/page.ts";
import type { LocaleParams } from "./(public)/_components/page.ts";
import { HomeContent } from "./(public)/HomeContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/", "home");
}

/** `/`: the landing page of the public site (WPP-T1, 16.8). */
export default async function HomePage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce] = await Promise.all([publicCatalog(), requestNonce()]);
  return (
    <PublicFrame locale={locale} path="/" {...menuOf(catalog)}>
      <HomeContent locale={locale} catalog={catalog} origin={publicOrigin()} nonce={nonce} />
    </PublicFrame>
  );
}
