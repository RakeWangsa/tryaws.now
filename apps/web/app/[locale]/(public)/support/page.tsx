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

/** `/support`: the public contact page (WPP-T2). The phone and the address are a Needs decision. */
export default async function SupportPage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce, signedIn] = await Promise.all([
    publicCatalog(),
    requestNonce(),
    publicSignedIn(),
  ]);
  return (
    <PublicFrame signedIn={signedIn} locale={locale} path="/support" {...menuOf(catalog)}>
      <SupportContent
        locale={locale}
        origin={publicOrigin()}
        nonce={nonce}
        phone={null}
        email={null}
      />
    </PublicFrame>
  );
}
