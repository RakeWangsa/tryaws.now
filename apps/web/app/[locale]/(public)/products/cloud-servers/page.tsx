import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../../../../server/public/load.ts";
import { PublicFrame } from "../../_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "../../_components/page.ts";
import type { LocaleParams } from "../../_components/page.ts";
import { CloudServersContent } from "./CloudServersContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/products/cloud-servers", "cloudServers");
}

/** `/products/cloud-servers`: plans, features, picker, specifications and FAQ (WPP-T1). */
export default async function CloudServersPage({ params }: LocaleParams) {
  const locale = await localeOf(params);
  const [catalog, nonce] = await Promise.all([publicCatalog(), requestNonce()]);
  return (
    <PublicFrame locale={locale} path="/products/cloud-servers" {...menuOf(catalog)}>
      <CloudServersContent
        locale={locale}
        catalog={catalog}
        origin={publicOrigin()}
        nonce={nonce}
      />
    </PublicFrame>
  );
}
