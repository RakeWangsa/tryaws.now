import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../server/public/load.ts";
import { publicSignedIn } from "../../../../server/public/signed-in.ts";
import { PublicFrame } from "../_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "../_components/page.ts";
import type { LocaleParams } from "../_components/page.ts";
import { PricingContent } from "./PricingContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/pricing", "pricing");
}

/** `/pricing`: every price is the pricing engine's output for a catalog row (WPP-T1, R4). */
export default async function PricingPage({
  params,
  searchParams,
}: LocaleParams & { searchParams: Promise<{ region?: string | string[] }> }) {
  const { region } = await searchParams;
  const locale = await localeOf(params);
  const [catalog, nonce, signedIn] = await Promise.all([
    publicCatalog(),
    requestNonce(),
    publicSignedIn(),
  ]);
  return (
    <PublicFrame signedIn={signedIn} locale={locale} path="/pricing" {...menuOf(catalog)}>
      <PricingContent
        locale={locale}
        catalog={catalog}
        origin={publicOrigin()}
        nonce={nonce}
        region={typeof region === "string" ? region : undefined}
      />
    </PublicFrame>
  );
}
