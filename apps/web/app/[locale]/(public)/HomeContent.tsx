import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { PublicCatalog } from "../../../server/public/catalog.ts";
import { breadcrumbLd } from "../../../server/public/seo.ts";
import { AnswerBlock } from "./_components/AnswerBlock.tsx";
import { JsonLds } from "./_components/JsonLd.tsx";
import { useSiteLd } from "./_components/site-ld.ts";
import type { Tr } from "./_components/offers.tsx";
import {
  Compare,
  Faq,
  FinalCta,
  Hero,
  Locations,
  Plans,
  Products,
  Steps,
  TrustStrip,
} from "./home/HomeSections.tsx";

// `/` (index.html), redesigned in WPU-X13. Top to bottom: the hero (one headline, one line, two buttons,
// the panel picture), the trust strip with the entity statement (the answer block of WPU-Z16), three
// steps, the product grid (a product whose flag is off says "coming soon"), plan cards from the live
// catalog, the comparison with an own AWS account, the two locations, the FAQ and the closing call to
// action. Not used from the mockup: the case study block, the map of seven datacenters, the stock
// photos and the animation scripts (U2, U13).

export function HomeContent({
  locale,
  catalog,
  origin,
  nonce,
}: {
  locale: Locale;
  catalog: PublicCatalog;
  origin: string | null;
  nonce: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  const tAws = useTranslations("Aws");
  const site = useSiteLd(locale);

  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          ...site(o, {
            path: "/",
            name: t("meta.home.title"),
            description: t("meta.home.description"),
            answer: true,
          }),
          breadcrumbLd(o, locale, [{ name: t("crumb.home"), path: "/" }]),
        ]}
      />
      <Hero t={t} locale={locale} />
      {/* WPU-Z16: the answer block is the entity statement (who, what, where, how billed). */}
      <TrustStrip t={t} answer={<AnswerBlock text={t("entity.statement")} />} />
      <Steps t={t} />
      <Products t={t} locale={locale} catalog={catalog} statement={tAws("long")} />
      <Plans t={t} locale={locale} catalog={catalog} />
      <Compare t={t} />
      <Locations t={t} locale={locale} />
      <Faq t={t} locale={locale} />
      <FinalCta t={t} locale={locale} />
    </>
  );
}
