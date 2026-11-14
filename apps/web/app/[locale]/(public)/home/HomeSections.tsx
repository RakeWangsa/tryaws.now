import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useFormatter } from "next-intl";
import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";
import { FaqList } from "../_components/FaqList.tsx";
import { OfferCard, locationName } from "../_components/offers.tsx";
import type { Tr } from "../_components/offers.tsx";
import { HOME_FAQ_KEYS, HOME_REGIONS, homePlans, homeProducts } from "./home-data.ts";

// WPU-X13: the sections of the home page. Server Components, no script. Every class is a class of the
// mockup (index.html, datacenter.html, hosting.html, faq.html) or a `tc-` class of tc.css section 11.
// Every text is a message of `Public.home` (U5), and every claim in it is one the repository can show.

/** The drawing of the hero panel: a rack of three server units. Decorative, made for this site. */
function RackDrawing() {
  return (
    <svg
      className="tc-hero-art"
      viewBox="0 0 320 170"
      width="320"
      height="170"
      aria-hidden="true"
      focusable="false"
    >
      {[0, 1, 2].map((row) => (
        <g key={row} transform={`translate(0 ${row * 54})`}>
          <rect className="tc-art-line" x="8" y="8" width="304" height="42" rx="8" />
          <line className="tc-art-line" x1="28" y1="29" x2="170" y2="29" />
          <line className="tc-art-line" x1="28" y1="21" x2="110" y2="21" />
          <circle className="tc-art-led" cx="268" cy="29" r="5" />
          <circle className="tc-art-accent" cx="288" cy="29" r="5" />
        </g>
      ))}
    </svg>
  );
}

export function Hero({ t, locale }: { t: Tr; locale: Locale }) {
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="top-header sec-bg6 bg-colorstyle tc-hero">
      <div className="container">
        <div className="row align-items-center">
          <div className="col-lg-7">
            <div className="wrapper">
              <h1 className="heading mergecolor pb-2 tc-hero-title">{t("home.heroTitle")}</h1>
              <p className="seccolor tc-hero-lead">{t("home.heroLead")}</p>
              <Button variant="primary" href={p("/pricing")} className="me-2 mb-2">
                {t("common.seePricing")}
              </Button>
              <Button variant="secondary" href={p("/signup")} className="mb-2">
                {t("home.heroSignup")}
              </Button>
            </div>
          </div>
          <div className="col-lg-5 mt-5 mt-lg-0">
            <div
              className="tc-hero-panel bg-seccolorstyle"
              role="group"
              aria-label={t("home.panel.label")}
            >
              <RackDrawing />
              <p className="h5 mergecolor mb-1">{t("home.panel.title")}</p>
              <p className="seccolor small mb-3">{t("home.panel.engine")}</p>
              <ul className="tc-hero-list seccolor">
                <li>
                  <i className="fas fa-map-marker-alt c-pink" aria-hidden="true" />
                  <span>{t("home.panel.location")}</span>
                </li>
                <li>
                  <i className="fas fa-wallet c-pink" aria-hidden="true" />
                  <span>{t("home.panel.wallet")}</span>
                </li>
                <li>
                  <i className="fas fa-sliders-h c-pink" aria-hidden="true" />
                  <span>{t("home.panel.panel")}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const TRUST = [
  { key: "aws", icon: "fas fa-cloud" },
  { key: "eps", icon: "fas fa-wallet" },
  { key: "regions", icon: "fas fa-globe-asia" },
  { key: "support", icon: "fas fa-headset" },
] as const;

/** Four facts that are true today, and the entity statement (AEO answer block) under them. */
export function TrustStrip({ t, answer }: { t: Tr; answer: React.ReactNode }) {
  return (
    <section className="bg-seccolorstyle tc-trust" aria-label={t("home.trustLabel")}>
      <div className="container">
        <div className="row g-4">
          {TRUST.map((item) => (
            <div key={item.key} className="col-sm-6 col-lg-3">
              <div className="tc-trust-item">
                <span className="tc-trust-icon">
                  <i className={item.icon} aria-hidden="true" />
                </span>
                <div>
                  <p className="tc-trust-title mergecolor">{t(`home.trust.${item.key}.title`)}</p>
                  <p className="tc-trust-text seccolor">{t(`home.trust.${item.key}.text`)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="row mt-4">
          <div className="col-lg-10">
            <h2 className="h5 mergecolor">{t("home.aboutTitle")}</h2>
            {answer}
          </div>
        </div>
      </div>
    </section>
  );
}

const STEPS = ["topup", "plan", "ready"] as const;

export function Steps({ t }: { t: Tr }) {
  const format = useFormatter();
  return (
    <section className="sec-bg2 bg-colorstyle tc-section">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.stepsTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.stepsLead")}</p>
        </div>
        <ol className="row g-4 list-unstyled mb-0">
          {STEPS.map((key, index) => (
            <li key={key} className="col-md-4">
              <div className="tc-tile bg-seccolorstyle">
                <span className="tc-step-number" aria-hidden="true">
                  {format.number(index + 1)}
                </span>
                <p className="tc-step-label seccolor mt-3 mb-0">
                  {t("home.stepLabel", { number: format.number(index + 1) })}
                </p>
                <h3 className="tc-tile-title mergecolor">{t(`home.steps.${key}.title`)}</h3>
                <p className="tc-tile-text seccolor">{t(`home.steps.${key}.text`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The product grid. A product whose flag is off is "coming soon" and is never promised (R12). */
export function Products({
  t,
  locale,
  catalog,
  statement,
}: {
  t: Tr;
  locale: Locale;
  catalog: PublicCatalog;
  statement: string;
}) {
  const products = homeProducts(catalog);
  return (
    <section className="bg-seccolorstyle tc-section">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.productsTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.productsLead")}</p>
        </div>
        {products.length === 0 ? (
          <EmptyState
            title={t("common.unavailableTitle")}
            description={t("common.unavailableText")}
          />
        ) : (
          <ul className="row g-4 list-unstyled mb-0">
            {products.map((product) => (
              <li key={product.key} className="col-sm-6 col-lg-4 col-xl-3">
                <div
                  className={
                    product.open ? "tc-tile bg-colorstyle" : "tc-tile tc-tile-soon bg-colorstyle"
                  }
                >
                  <i className={`${product.icon} fa-lg c-pink`} aria-hidden="true" />
                  <h3 className="tc-tile-title mergecolor">
                    {t(`home.products.${product.key}.title`)}
                  </h3>
                  <p className="tc-tile-text seccolor">{t(`home.products.${product.key}.text`)}</p>
                  {product.open ? (
                    <span className="badge bg-success">
                      <i className="fas fa-check" aria-hidden="true" /> {t("home.productOpen")}
                    </span>
                  ) : (
                    <span className="badge bg-secondary">
                      <i className="fas fa-clock" aria-hidden="true" /> {t("common.comingSoon")}
                    </span>
                  )}
                  {product.path !== null ? (
                    <p className="mt-3 mb-0">
                      <a href={localePath(locale, product.path)} className="golink">
                        {t("home.productsOpenLink", {
                          name: t(`home.products.${product.key}.title`),
                        })}
                      </a>
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="seccolor text-center mt-4 mb-0">{statement}</p>
      </div>
    </section>
  );
}

export function Plans({ t, locale, catalog }: { t: Tr; locale: Locale; catalog: PublicCatalog }) {
  const plans: readonly PublicOffer[] = homePlans(catalog);
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="pricing special sec-bg2 bg-colorstyle tc-section" id="plans">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.plansTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.plansLead")}</p>
        </div>
        {plans.length > 0 ? (
          <div className="row justify-content-center">
            {plans.map((offer, index) => (
              <div
                key={offer.id}
                className={
                  plans.length >= 4
                    ? "col-md-6 col-xl-3 tc-plan-col"
                    : "col-md-6 col-lg-4 tc-plan-col"
                }
              >
                <OfferCard
                  t={t}
                  locale={locale}
                  offer={offer}
                  recommended={plans.length >= 3 && index === 1}
                  label={t("common.seePlans")}
                  href={p("/products/cloud-servers")}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title={catalog.state === "ok" ? t("common.noPlansTitle") : t("common.unavailableTitle")}
            description={
              catalog.state === "ok" ? t("common.noPlansText") : t("common.unavailableText")
            }
          />
        )}
        <p className="tc-plan-more">
          <Button variant="secondary" href={p("/pricing")}>
            {t("home.plansAll")}
          </Button>
        </p>
        <p className="small seccolor text-center mt-3 mb-0">{t("common.priceNote")}</p>
      </div>
    </section>
  );
}

const COMPARE = ["card", "usd", "tax", "console"] as const;

/** Your own AWS account against TryAWS.now: how you buy, pay and manage, not a price claim. */
export function Compare({ t }: { t: Tr }) {
  return (
    <section className="bg-seccolorstyle tc-section">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.compareTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.compareLead")}</p>
        </div>
        <div className="table-responsive-lg">
          <table className="table compare">
            <caption className="visually-hidden">{t("home.compareCaption")}</caption>
            <thead>
              <tr>
                <th scope="col" className="title mergecolor border-start-0 tc-compare-col">
                  {t("home.compareFeature")}
                </th>
                <th scope="col" className="title mergecolor border-start-0 tc-compare-col">
                  {t("home.compareOwn")}
                </th>
                <th scope="col" className="title mergecolor border-start-0 tc-compare-col">
                  {t("home.compareHere")}
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((key) => (
                <tr key={key}>
                  <th scope="row" className="mergecolor">
                    {t(`home.compare.${key}.label`)}
                  </th>
                  <td className="seccolor">{t(`home.compare.${key}.own`)}</td>
                  <td>
                    <b className="c-black mergecolor">{t(`home.compare.${key}.here`)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Locations({ t, locale }: { t: Tr; locale: Locale }) {
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="bg-colorstyle tc-section">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.locationsTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.locationsText")}</p>
        </div>
        <div className="row g-4 justify-content-center">
          {HOME_REGIONS.map((region) => (
            <div key={region} className="col-md-6 col-lg-5">
              <div className="tc-tile bg-seccolorstyle">
                <i className="fas fa-map-marker-alt fa-lg c-pink" aria-hidden="true" />
                <h3 className="tc-tile-title mergecolor">{locationName(t, region)}</h3>
                <p className="tc-tile-text seccolor">
                  {t("home.locationRegion", { name: t(`home.regionNames.${region}`) })}
                </p>
                <p className="tc-location-code seccolor">{region}</p>
                <Button variant="secondary" href={`${p("/pricing")}?region=${region}`}>
                  {t("home.locationCta", { location: locationName(t, region) })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Faq({ t, locale }: { t: Tr; locale: Locale }) {
  const items = HOME_FAQ_KEYS.map((key) => ({
    question: t(`help.items.${key}.q`),
    answer: t(`help.items.${key}.a`),
  }));
  return (
    <section className="sec-bg2 bg-seccolorstyle tc-section">
      <div className="container">
        <div className="tc-section-head">
          <h2 className="section-heading mergecolor">{t("home.faqTitle")}</h2>
          <p className="section-subheading seccolor">{t("home.faqLead")}</p>
        </div>
        <FaqList items={items} />
        <p className="text-center mt-4 mb-0">
          <Button variant="secondary" href={localePath(locale, "/help")}>
            {t("home.faqAll")}
          </Button>
        </p>
      </div>
    </section>
  );
}

export function FinalCta({ t, locale }: { t: Tr; locale: Locale }) {
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="getready sec-bg1 bg-seccolorstyle tc-cta-band">
      <div className="container">
        <div className="row align-items-center">
          <div className="col-lg-8">
            <div className="column-support-txt">
              <h2 className="column-support-title text-dark mergecolor">{t("home.ctaTitle")}</h2>
              <div className="column-support-subtitle text-dark mergecolor">
                {t("home.ctaText")}
              </div>
            </div>
          </div>
          <div className="col-lg-4">
            <div className="btn-floats">
              <Button variant="primary" href={p("/signup")} className="me-3">
                {t("home.heroSignup")}
              </Button>
              <Button variant="secondary" href={p("/pricing")}>
                {t("common.seePricing")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
