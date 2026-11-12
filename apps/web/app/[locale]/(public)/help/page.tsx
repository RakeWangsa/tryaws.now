import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../server/public/load.ts";
import { publicSignedIn } from "../../../../server/public/signed-in.ts";
import { PublicFrame } from "../_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "../_components/page.ts";
import type { LocaleParams } from "../_components/page.ts";
import { HelpContent } from "./HelpContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/help", "help");
}

/** `/help`: the FAQ (WPP-T2). */
export default async function HelpPage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce, signedIn] = await Promise.all([
    publicCatalog(),
    requestNonce(),
    publicSignedIn(),
  ]);
  return (
    <PublicFrame signedIn={signedIn} locale={locale} path="/help" {...menuOf(catalog)}>
      <HelpContent locale={locale} origin={publicOrigin()} nonce={nonce} />
    </PublicFrame>
  );
}
