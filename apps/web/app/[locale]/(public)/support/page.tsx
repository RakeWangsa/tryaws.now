import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../server/public/load.ts";
import { publicSignedIn } from "../../../../server/public/signed-in.ts";
import { PublicFrame } from "../_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "../_components/page.ts";
import type { LocaleParams } from "../_components/page.ts";
import { SupportContent } from "./SupportContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/support", "support");
}

/**
 * `/support`: the public support page (WPP-T2). Support is given through support requests only, with
 * no support phone and no support e-mail (owner decision 2026-11-13, WPU-Z7).
 */
export default async function SupportPage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce, signedIn] = await Promise.all([
    publicCatalog(),
    requestNonce(),
    publicSignedIn(),
  ]);
  return (
    <PublicFrame signedIn={signedIn} locale={locale} path="/support" {...menuOf(catalog)}>
      <SupportContent locale={locale} origin={publicOrigin()} nonce={nonce} />
    </PublicFrame>
  );
}
