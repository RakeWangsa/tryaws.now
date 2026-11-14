import { Button, EmptyState, Tabs } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { PublicCatalog } from "../../../../server/public/catalog.ts";
import { breadcrumbLd, productLd } from "../../../../server/public/seo.ts";
import { localePath } from "@tc/ui/runtime";
import { AnswerBlock } from "../_components/AnswerBlock.tsx";
import { JsonLds } from "../_components/JsonLd.tsx";
import { useSiteLd } from "../_components/site-ld.ts";
import {
  OfferCard,
  OfferTable,
  locationName,
  offerName,
  orderHref,
} from "../_components/offers.tsx";
import type { Tr } from "../_components/offers.tsx";
import { HOME_REGIONS } from "../home/home-data.ts";

// `/pricing` (pricing.html): one tab for each open family with plan boxes and the comparison table
// (`table.table.compare`). Not used: the carousel and the slider demos. Every price is an offer of
// the live catalog, as the pricing engine priced it.

export function PricingContent({
  locale,
  catalog,
  origin,
  nonce,
  region,
}: {
  locale: Locale;
  catalog: PublicCatalog;
  origin: string | null;
  nonce: string | undefined;
  /** The `region` of the query: one of the two known codes, or anything else for all locations. */
  region?: string | undefined;
}) {
  const t = useTranslations("Public") as unknown as Tr;
  // WPU-X13: the location filter is a link with a query, no script. An unknown value shows everything.
  const active = HOME_REGIONS.find((code) => code === region) ?? null;
  const families =
    catalog.state === "ok"
      ? catalog.families
          .map((f) => ({
            ...f,
            offers: active === null ? f.offers : f.offers.filter((o) => o.region === active),
          }))
          .filter((f) => f.offers.length > 0)
      : [];
  const pricingPath = localePath(locale, "/pricing");
  const offers = families.flatMap((family) => family.offers);
  const site = useSiteLd(locale);

  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          ...site(o, {
            path: "/pricing",
            name: t("meta.pricing.title"),
            description: t("meta.pricing.description"),
            answer: true,
          }),
          breadcrumbLd(o, locale, [
            { name: t("crumb.home"), path: "/" },
            { name: t("pricing.heading"), path: "/pricing" },
          ]),
          ...(offers.length > 0
            ? [
                productLd({
                  name: t("pricing.heading"),
                  description: t("meta.pricing.description"),
                  url: o + localePath(locale, "/pricing"),
                  offers: offers.map((offer) => ({
                    name: offerName(t, offer),
                    priceUsd: offer.priceUsd,
                    url: o + orderHref(locale),
                  })),
                }),
              ]
            : []),
        ]}
      />
      <div className="top-header item1 overlay">
        <div className="container">
          <div className="row">
            <div className="col-lg-12">
              <div className="wrapper">
                <h1 className="heading">{t("pricing.heading")}</h1>
                <AnswerBlock text={t("pricing.answer")} />
                <p className="mergecolor fw-bold">
                  <i className="fas fa-check-circle c-pink" aria-hidden="true" />{" "}
                  {t("pricing.vatNote")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <section className="pricing special sec-normal motpath bg-colorstyle">
        <div className="container">
          {catalog.state === "unavailable" ? (
            <EmptyState
              title={t("common.unavailableTitle")}
              description={t("common.unavailableText")}
            />
          ) : families.length === 0 ? (
            <EmptyState title={t("common.noPlansTitle")} description={t("common.noPlansText")} />
          ) : (
            <>
              <nav className="text-center mb-4" aria-label={t("pricing.regionNavLabel")}>
                <span className="seccolor me-2">{t("common.locationHeading")}:</span>
                <Button
                  variant={active === null ? "primary" : "secondary"}
                  href={pricingPath}
                  className="me-2 mb-2"
                  icon={active === null ? "fas fa-check" : undefined}
                >
                  {t("pricing.regionAll")}
                  {active === null ? (
                    <span className="visually-hidden"> {t("pricing.regionCurrent")}</span>
                  ) : null}
                </Button>
                {HOME_REGIONS.map((code) => (
                  <Button
                    key={code}
                    variant={active === code ? "primary" : "secondary"}
                    href={`${pricingPath}?region=${code}`}
                    className="me-2 mb-2"
                    icon={active === code ? "fas fa-check" : undefined}
                  >
                    {locationName(t, code)}
                    {active === code ? (
                      <span className="visually-hidden"> {t("pricing.regionCurrent")}</span>
                    ) : null}
                  </Button>
                ))}
              </nav>
              <Tabs
                label={t("pricing.tabsLabel")}
                tabs={families.map((family) => ({
                  id: family.family,
                  title: t(`product.${family.family}`),
                  content: (
                    <>
                      <h2 className="section-heading mergecolor text-center">
                        {t("pricing.tableTitle")}
                      </h2>
                      <div className="row">
                        {family.offers.slice(0, 3).map((offer, index) => (
                          <div key={offer.id} className="col-md-12 col-lg-4">
                            <OfferCard
                              t={t}
                              locale={locale}
                              offer={offer}
                              recommended={index === 0}
                            />
                          </div>
                        ))}
                      </div>
                      <OfferTable
                        t={t}
                        locale={locale}
                        offers={family.offers}
                        caption={t("pricing.tableCaption")}
                      />
                    </>
                  ),
                }))}
              />
            </>
          )}
          <p className="small seccolor text-center mt-3">{t("common.priceNote")}</p>
        </div>
      </section>
      <section className="sec-normal bg-colorstyle">
        <div className="container text-center">
          <h2 className="section-heading mergecolor">{t("pricing.otherFamilies")}</h2>
          <p className="seccolor">{t("pricing.otherFamiliesText")}</p>
        </div>
      </section>
    </>
  );
}
