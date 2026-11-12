import { Button, EmptyState, HelpStrip } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { cheapestOffer } from "../../../server/public/catalog.ts";
import type { PublicCatalog } from "../../../server/public/catalog.ts";
import { breadcrumbLd, organizationLd } from "../../../server/public/seo.ts";
import { JsonLds } from "./_components/JsonLd.tsx";
import { OfferCard } from "./_components/offers.tsx";
import type { Tr } from "./_components/offers.tsx";

// `/` (index.html): the hero with the AWS statement of 16.13, three plan cards from the catalog (the
// cheapest open plan of three families), "Why MeghVPS" tiles, the two locations as text, the
// help strip. Not used from the mockup: the case study block and the map of seven datacenters.

const WHY = ["aws", "bdt", "panel", "support"] as const;

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
  const p = (path: string): string => localePath(locale, path);

  // The cheapest offer of each family that has one; at most three cards.
  const cards =
    catalog.state === "ok"
      ? catalog.families
          .map((family) => ({ family: family.family, offer: cheapestOffer(family.offers) }))
          .filter((card) => card.offer !== null)
          .slice(0, 3)
      : [];

  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          organizationLd(o),
          breadcrumbLd(o, locale, [{ name: t("crumb.home"), path: "/" }]),
        ]}
      />
      <section className="top-header sec-bg6 pb-150 bg-colorstyle">
        <div className="container">
          <div className="row">
            <div className="col-md-8">
              <div className="wrapper">
                <h1 className="heading mergecolor pb-2">{t("home.heroTitle")}</h1>
                <h2 className="subheading fw-normal text-muted mb-4">{t("home.heroLead")}</h2>
                <p className="seccolor mb-4">{tAws("long")}</p>
                <Button variant="primary" href={p("/pricing")} className="me-2">
                  {t("common.seePricing")}
                </Button>
                <Button variant="secondary" href={p("/products/cloud-servers")}>
                  {t("common.seePlans")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pricing special sec-bg2 bg-colorstyle specialposition">
        <div className="container">
          <div className="sec-up-slider nopadding">
            <div className="text-center mb-4">
              <h2 className="section-heading mergecolor">{t("home.plansTitle")}</h2>
              <p className="section-subheading seccolor">{t("home.plansLead")}</p>
            </div>
            {cards.length > 0 ? (
              <div className="row">
                {cards.map((card, index) => (
                  <div key={card.family} className="col-md-12 col-lg-4">
                    <OfferCard
                      t={t}
                      locale={locale}
                      offer={card.offer!}
                      recommended={index === 0}
                      label={t("common.seePlans")}
                      href={p("/products/cloud-servers")}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title={
                  catalog.state === "ok" ? t("common.noPlansTitle") : t("common.unavailableTitle")
                }
                description={
                  catalog.state === "ok" ? t("common.noPlansText") : t("common.unavailableText")
                }
              />
            )}
            <p className="small seccolor text-center mt-3">{t("common.priceNote")}</p>
          </div>
        </div>
      </section>

      <section className="services sec-normal sec-bg4">
        <div className="container">
          <div className="service-wrap">
            <div className="row">
              <div className="col-sm-12 text-center">
                <h2 className="section-heading">{t("home.whyTitle")}</h2>
              </div>
              {WHY.map((key) => (
                <div key={key} className="col-md-12 col-lg-6 col-xl-3">
                  <div className="service-section bg-colorstyle">
                    <h3 className="title mergecolor h5">{t(`home.why.${key}.title`)}</h3>
                    <p className="subtitle seccolor">{t(`home.why.${key}.text`)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="services maping sec-normal sec-grad-grey-to-grey bg-colorstyle pb-5">
        <div className="container">
          <div className="service-wrap">
            <div className="row">
              <div className="col-sm-12 text-center">
                <h2 className="section-heading text-white mergecolor">
                  {t("home.locationsTitle")}
                </h2>
                <p className="section-subheading text-light mergecolor">
                  {t("home.locationsText")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="container">
        <h2 className="visually-hidden">{t("home.helpTitle")}</h2>
      </div>
      <HelpStrip
        items={[
          {
            href: p("/help"),
            title: t("home.help.faq.title"),
            description: t("home.help.faq.text"),
            icon: "fas fa-question-circle",
          },
          {
            href: p("/support"),
            title: t("home.help.support.title"),
            description: t("home.help.support.text"),
            icon: "fas fa-headset",
          },
          {
            href: p("/pricing"),
            title: t("home.help.pricing.title"),
            description: t("home.help.pricing.text"),
            icon: "fas fa-tags",
          },
        ]}
      />
    </>
  );
}
