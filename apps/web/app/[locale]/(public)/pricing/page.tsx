import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../server/public/load.ts";
import { PublicFrame } from "../_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "../_components/page.ts";
import type { LocaleParams } from "../_components/page.ts";
import { PricingContent } from "./PricingContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/pricing", "pricing");
}

/** `/pricing`: every price is the pricing engine's output for a catalog row (WPP-T1, R4). */
export default async function PricingPage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce] = await Promise.all([publicCatalog(), requestNonce()]);
  return (
    <PublicFrame locale={locale} path="/pricing" {...menuOf(catalog)}>
      <PricingContent locale={locale} catalog={catalog} origin={publicOrigin()} nonce={nonce} />
    </PublicFrame>
  );
}
