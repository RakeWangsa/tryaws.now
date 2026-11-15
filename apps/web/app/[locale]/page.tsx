import type { Metadata } from "next";
import { publicCatalog, publicOrigin, requestNonce } from "../../server/public/load.ts";
import { publicSignedIn } from "../../server/public/signed-in.ts";
import { PublicFrame } from "./(public)/_components/PublicFrame.tsx";
import { localeOf, menuOf, metadataOf } from "./(public)/_components/page.ts";
import type { LocaleParams } from "./(public)/_components/page.ts";
import { HomeContent } from "./(public)/HomeContent.tsx";

export function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return metadataOf(params, "/", "home");
}

/** `/`: the simple home page of the public site (WPU-X18): services and a read-only instance chooser. */
export default async function HomePage({
  params,
  searchParams,
}: LocaleParams & {
  searchParams?: Promise<{ region?: string | string[]; platform?: string | string[] }>;
}) {
  const { region, platform } = (await searchParams) ?? {};
  const locale = await localeOf(params);
  const [catalog, nonce, signedIn] = await Promise.all([
    publicCatalog(),
    requestNonce(),
    publicSignedIn(),
  ]);
  return (
    <PublicFrame signedIn={signedIn} locale={locale} path="/" {...menuOf(catalog)}>
      <HomeContent
        locale={locale}
        catalog={catalog}
        origin={publicOrigin()}
        nonce={nonce}
        region={typeof region === "string" ? region : undefined}
        platform={typeof platform === "string" ? platform : undefined}
        signedIn={signedIn}
      />
    </PublicFrame>
  );
}
