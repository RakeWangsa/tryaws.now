import { Accordion, Button, EmptyState, PlanPicker } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { PublicCatalog, PublicOffer } from "../../../../../server/public/catalog.ts";
import { breadcrumbLd, faqLd, productLd } from "../../../../../server/public/seo.ts";
import { JsonLds } from "../../_components/JsonLd.tsx";
import {
  OfferCard,
  OfferTable,
  offerNumerals,
  offerName,
  orderHref,
  specValues,
} from "../../_components/offers.tsx";
import type { Tr } from "../../_components/offers.tsx";

// `/products/cloud-servers` (vps.html): plan cards, the feature blocks (`section#features`), the plan
// picker (`section#custom`), the specification table (`section#specs`) and the FAQ. Linux and
// Windows plans are the families of Cloud Server whose flag is on.

const FEATURES = ["panel", "backup", "bdt", "locations"] as const;
const FAQ_KEYS = ["realAws", "noAccount", "billing", "dataLocation"] as const;
const CLOUD_FAMILIES = new Set(["linux_instance", "windows_instance"]);

export function cloudOffers(catalog: PublicCatalog): PublicOffer[] {
  if (catalog.state !== "ok") return [];
  return catalog.families.filter((f) => CLOUD_FAMILIES.has(f.family)).flatMap((f) => f.offers);
}

export function CloudServersContent({
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
  const offers = cloudOffers(catalog);
  const faq = FAQ_KEYS.map((key) => ({
    question: t(`help.items.${key}.q`),
    answer: t(`help.items.${key}.a`),
  }));

  return (
    <>
      <JsonLds
        origin={origin}
        nonce={nonce}
        build={(o) => [
          breadcrumbLd(o, locale, [
            { name: t("crumb.home"), path: "/" },
            { name: t("cloudServers.heading"), path: "/products/cloud-servers" },
          ]),
          faqLd(faq),
          ...(offers.length > 0
            ? [
                productLd({
                  name: t("product.linux_instance"),
                  description: t("meta.cloudServers.description"),
                  url: o + localePath(locale, "/products/cloud-servers"),
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

      <div className="top-header overlay-video">
        <div className="container">
          <div className="row">
            <div className="col-lg-9">
              <div className="wrapper">
                <h1 className="heading">{t("cloudServers.heading")}</h1>
                <p className="seccolor">{t("cloudServers.lead")}</p>
                <p className="seccolor">{tAws("long")}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="pricing special sec-normal pt-80 pb-0 bg-colorstyle">
        <div className="container">
          <h2 className="section-heading mergecolor text-center">{t("cloudServers.plansTitle")}</h2>
          {offers.length > 0 ? (
            <div className="row">
              {offers.slice(0, 3).map((offer, index) => (
                <div key={offer.id} className="col-md-12 col-lg-4">
                  <OfferCard t={t} locale={locale} offer={offer} recommended={index === 0} />
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
      </section>

      <section id="features" className="history-section feat01 sec-normal bg-colorstyle">
        <div className="container">
          <h2 className="fw-bold mb-3 mergecolor text-center">{t("cloudServers.featuresTitle")}</h2>
          <div className="row">
            {FEATURES.map((key) => (
              <div key={key} className="col-md-6 col-lg-3">
                <h3 className="h5 mergecolor">{t(`cloudServers.features.${key}.title`)}</h3>
                <p className="seccolor">{t(`cloudServers.features.${key}.text`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {offers.length > 0 ? (
        <section id="custom" className="sec-normal overlay">
          <div className="container">
            <h2 className="section-heading text-white">{t("cloudServers.pickerTitle")}</h2>
            <form method="get" action={localePath(locale, "/login")}>
              <input type="hidden" name="next" value="/servers/new" />
              <PlanPicker
                name="plan"
                {...(offers[0] ? { numerals: offerNumerals(locale, offers[0]) } : {})}
                legend={t("cloudServers.pickerLegend")}
                plans={offers.map((offer) => ({
                  id: offer.id,
                  name: offerName(t, offer),
                  priceUsd: offer.priceUsd,
                  lines: [
                    specValues(t, offer.specs).cpu,
                    specValues(t, offer.specs).ram,
                    specValues(t, offer.specs).disk,
                  ],
                }))}
              />
              <button type="submit" className="btn btn-default-yellow-fill mt-3">
                {t("common.orderNow")}
              </button>
            </form>
          </div>
        </section>
      ) : null}

      <section id="specs" className="sec-normal sec-bg1 bg-colorstyle pb-80">
        <div className="container">
          <h2 className="section-heading mergecolor">{t("cloudServers.specsTitle")}</h2>
          {offers.length > 0 ? (
            <OfferTable t={t} locale={locale} offers={offers} caption={t("pricing.tableCaption")} />
          ) : null}
        </div>
      </section>

      <section className="sec-normal bg-colorstyle">
        <div className="container">
          <h2 className="section-heading mergecolor">{t("cloudServers.faqTitle")}</h2>
          <Accordion
            headingLevel={3}
            items={faq.map((item, index) => ({
              id: FAQ_KEYS[index] as string,
              title: item.question,
              content: <p className="seccolor">{item.answer}</p>,
            }))}
          />
          <Button variant="tertiary" href={localePath(locale, "/help")}>
            {t("home.help.faq.title")}
          </Button>
        </div>
      </section>
    </>
  );
}
