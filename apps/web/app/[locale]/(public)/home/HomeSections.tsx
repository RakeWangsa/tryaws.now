import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { PublicCatalog } from "../../../../server/public/catalog.ts";
import { OfferCard, locationName, orderHref } from "../_components/offers.tsx";
import type { Tr } from "../_components/offers.tsx";
import { homeChooser, homeServices } from "./home-data.ts";
import type { HomePlatform } from "./home-data.ts";

// WPU-X18: the home page is a simple page that feels like the Lightsail console: a heading, the list of
// services and a read-only preview of the create-instance choice (location, platform, plan). Server
// Components, no script: a choice is a link with a query. Every class is a class of the mockup or a
// `tc-` class of tc.css section 11. Every text is a message of `Public.home` (U5). Creating happens in the
// panel after sign-in (R1): nothing here writes anything or calls AWS.

export function Hero({
  t,
  locale,
  signedIn,
  answer,
}: {
  t: Tr;
  locale: Locale;
  signedIn: boolean;
  /** The answer block (the entity statement, WPU-Z16). */
  answer: React.ReactNode;
}) {
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="top-header sec-bg6 bg-colorstyle tc-hero">
      <div className="container">
        <div className="wrapper">
          <h1 className="heading mergecolor pb-2 tc-hero-title">{t("home.heroTitle")}</h1>
          {answer}
          {signedIn ? (
            <Button variant="primary" href={p("/dashboard")} className="me-2 mb-2">
              {t("common.login")}
            </Button>
          ) : (
            <>
              <Button variant="primary" href={p("/login")} className="me-2 mb-2">
                {t("home.heroLogin")}
              </Button>
              <Button variant="secondary" href={p("/signup")} className="mb-2">
                {t("home.heroSignup")}
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The services list (left column). A service whose flag is off is "coming soon" and is never promised (R12). */
export function Services({
  t,
  locale,
  catalog,
}: {
  t: Tr;
  locale: Locale;
  catalog: PublicCatalog;
}) {
  const services = homeServices(catalog);
  return (
    <aside className="sidebar sec-bg1 bg-seccolorstyle noshadow tc-console-nav">
      <nav className="menu categories" aria-label={t("home.servicesLabel")}>
        <h2 className="h5 mergecolor">
          <b>{t("home.servicesTitle")}</b>
        </h2>
        <hr />
        {services.length === 0 ? (
          <EmptyState
            title={t("common.unavailableTitle")}
            description={t("common.unavailableText")}
          />
        ) : (
          <ul className="list-unstyled mb-0 tc-svc-list">
            {services.map((service) => {
              const name = t(`home.services.${service.key}`);
              return (
                <li key={service.key} className="tc-svc-item">
                  {service.path !== null ? (
                    <a href={localePath(locale, service.path)} className="golink mergecolor">
                      {name}
                    </a>
                  ) : (
                    <span className="mergecolor">{name}</span>
                  )}{" "}
                  {service.open ? (
                    <span className="badge bg-success">
                      <i className="fas fa-check" aria-hidden="true" /> {t("home.productOpen")}
                    </span>
                  ) : (
                    <span className="badge bg-secondary">
                      <i className="fas fa-clock" aria-hidden="true" /> {t("common.comingSoon")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}

/** The read-only preview of the create screen. The prices are the catalog's, as taka only (WPU-X16). */
export function Chooser({
  t,
  locale,
  catalog,
  region,
  platform,
  signedIn,
}: {
  t: Tr;
  locale: Locale;
  catalog: PublicCatalog;
  region: string | undefined;
  platform: string | undefined;
  signedIn: boolean;
}) {
  const chooser = homeChooser(catalog, { region, platform });
  const home = localePath(locale, "/");
  const link = (r: string, pl: HomePlatform): string =>
    `${home}?region=${r}&platform=${pl}#chooser`;
  const create = signedIn ? localePath(locale, "/servers/new") : orderHref(locale);
  return (
    <div id="chooser">
      <h2 className="section-heading mergecolor">{t("home.chooserTitle")}</h2>
      <p className="seccolor">{t("home.chooserLead")}</p>
      {chooser.state === "unavailable" ? (
        <EmptyState
          title={t("common.unavailableTitle")}
          description={t("common.unavailableText")}
        />
      ) : chooser.state === "closed" ? (
        <EmptyState title={t("common.noPlansTitle")} description={t("common.noPlansText")} />
      ) : (
        <>
          <nav aria-label={t("home.locationTitle")} className="mb-4">
            <h3 className="h5 mergecolor">{t("home.locationTitle")}</h3>
            {chooser.regions.map((code) => (
              <Button
                key={code}
                variant={code === chooser.region ? "primary" : "secondary"}
                href={link(code, chooser.platform)}
                className="me-2 mb-2"
                icon={code === chooser.region ? "fas fa-check" : undefined}
              >
                {locationName(t, code)}
                {code === chooser.region ? (
                  <span className="visually-hidden"> {t("pricing.regionCurrent")}</span>
                ) : null}
              </Button>
            ))}
            <p className="seccolor small mb-0">
              {t("home.locationRegion", { name: t(`home.regionNames.${chooser.region}`) })}
              {", "}
              <span className="tc-location-code">{chooser.region}</span>
            </p>
          </nav>
          <nav aria-label={t("home.platformTitle")} className="mb-4">
            <h3 className="h5 mergecolor">{t("home.platformTitle")}</h3>
            {chooser.platforms.map((key) => (
              <Button
                key={key}
                variant={key === chooser.platform ? "primary" : "secondary"}
                href={link(chooser.region, key)}
                className="me-2 mb-2"
                icon={key === chooser.platform ? "fas fa-check" : undefined}
              >
                {t(`home.platforms.${key}`)}
                {key === chooser.platform ? (
                  <span className="visually-hidden"> {t("pricing.regionCurrent")}</span>
                ) : null}
              </Button>
            ))}
          </nav>
          <section className="pricing special" aria-label={t("home.planTitle")}>
            <h3 className="h5 mergecolor">{t("home.planTitle")}</h3>
            <div className="row">
              {chooser.offers.map((offer) => (
                <div key={offer.id} className="col-md-6 col-xl-4 tc-plan-col">
                  <OfferCard
                    t={t}
                    locale={locale}
                    offer={offer}
                    label={t("home.createInstance")}
                    href={create}
                  />
                </div>
              ))}
            </div>
          </section>
          <p className="seccolor small">{t("home.createNote")}</p>
        </>
      )}
    </div>
  );
}

/** The trust line: what TryAWS.now is (the answer block of WPU-Z16 sits in the hero), the long AWS statement and the price note. */
export function About({ t, statement }: { t: Tr; statement: string }) {
  return (
    <section className="bg-seccolorstyle tc-trust">
      <div className="container text-center">
        <p className="seccolor mb-2">{statement}</p>
        <p className="small seccolor mb-0">{t("common.priceNote")}</p>
      </div>
    </section>
  );
}
