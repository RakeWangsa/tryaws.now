import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { PublicCatalog } from "../../../server/public/catalog.ts";
import { breadcrumbLd } from "../../../server/public/seo.ts";
import { AnswerBlock } from "./_components/AnswerBlock.tsx";
import { JsonLds } from "./_components/JsonLd.tsx";
import { useSiteLd } from "./_components/site-ld.ts";
import type { Tr } from "./_components/offers.tsx";
import { About, Chooser, Hero, Services } from "./home/HomeSections.tsx";

// `/` (index.html), simplified in WPU-X18 (owner request of 2026-11-15): a short heading with the
// statement of WPU-Z16 and the login and sign-up buttons, then the console feel: the list of services on
// the left and a read-only preview of the create-instance choice (location, platform, plan with its
// price in taka) on the right, set by `?region=&platform=` without a script. Creating happens in the
// panel after login. The marketing sections of WPU-X13 are gone (steps, comparison, locations, FAQ,
// closing call to action); /pricing and the other public pages are unchanged.

export function HomeContent({
  locale,
  catalog,
  origin,
  nonce,
  region,
  platform,
  signedIn = false,
}: {
  locale: Locale;
  catalog: PublicCatalog;
  origin: string | null;
  nonce: string | undefined;
  /** The `region` of the query; anything unknown falls back to the first location that has plans. */
  region?: string | undefined;
  /** The `platform` of the query: `linux` or `windows`; anything else falls back to the first. */
  platform?: string | undefined;
  /** A valid customer session exists: the create button then goes to the panel (a boolean only). */
  signedIn?: boolean;
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
      {/* WPU-Z16: the answer block is the entity statement (who, what, where, how billed). */}
      <Hero
        t={t}
        locale={locale}
        signedIn={signedIn}
        answer={<AnswerBlock text={t("entity.statement")} />}
      />
      <section className="bg-colorstyle tc-section">
        <div className="container">
          <div className="row g-4">
            <div className="col-lg-3">
              <Services t={t} locale={locale} catalog={catalog} />
            </div>
            <div className="col-lg-9">
              <Chooser
                t={t}
                locale={locale}
                catalog={catalog}
                region={region}
                platform={platform}
                signedIn={signedIn}
              />
            </div>
          </div>
        </div>
      </section>
      <About t={t} statement={tAws("long")} />
    </>
  );
}
