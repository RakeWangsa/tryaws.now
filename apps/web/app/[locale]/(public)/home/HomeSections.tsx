import { Button, EmptyState, MoneyText } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";
import type { PublicImages } from "../../../../server/public/images.ts";
import { locationName, offerNumerals, orderHref } from "../_components/offers.tsx";
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
  lead,
}: {
  t: Tr;
  locale: Locale;
  signedIn: boolean;
  /** One short sentence: the short AWS statement of 16.13. */
  lead: string;
}) {
  const p = (path: string): string => localePath(locale, path);
  return (
    <section className="top-header sec-bg6 bg-colorstyle tc-hero">
      <div className="container">
        <div className="wrapper">
          <h1 className="heading mergecolor pb-2 tc-hero-title">{t("home.heroTitle")}</h1>
          <p className="seccolor tc-hero-lead">{lead}</p>
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
                    <a
                      href={localePath(locale, service.path)}
                      className="golink mergecolor tc-svc-name"
                    >
                      {name}
                    </a>
                  ) : (
                    <span className="mergecolor tc-svc-name">{name}</span>
                  )}
                  {service.open ? (
                    <span className="badge bg-success tc-svc-badge">
                      <i className="fas fa-check" aria-hidden="true" /> {t("home.productOpen")}
                    </span>
                  ) : (
                    <span className="badge bg-secondary tc-svc-badge">
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

/**
 * A compact plan card: the size and the vCPU count as the title (two plans of one memory size differ in
 * vCPU, so the title is never the same twice), the disk and transfer on one line, the price in whole
 * taka (the engine's total, WPU-X16) and one button.
 */
function PlanMini({
  t,
  locale,
  offer,
  href,
}: {
  t: Tr;
  locale: Locale;
  offer: PublicOffer;
  href: string;
}) {
  const none = t("spec.none");
  const s = offer.specs;
  // The digits of the market setting, as the price (the unit letters stay as they are). Sizes are plain
  // counts, not money: no grouping, so "1000 GB" reads as on the pricing page.
  const tag = `${locale === "bn" ? "bn-BD" : "en-BD"}-u-nu-${offerNumerals(locale, offer)}`;
  const num = (v: number | string | undefined): string =>
    v === undefined
      ? none
      : new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: 2 }).format(
          Number(v),
        );
  return (
    <div className="tc-mini bg-seccolorstyle">
      <p className="tc-mini-title mergecolor">
        {t("home.cardTitle", { ram: num(s.ramGb), cpu: num(s.vcpus) })}
      </p>
      <p className="tc-mini-line seccolor">
        {t("home.cardLine", { disk: num(s.diskGb), transfer: num(s.transferGb) })}
      </p>
      <p className="tc-mini-price mergecolor">
        <MoneyText
          minor={offer.priceMinor}
          mode="wholeUp"
          numerals={offerNumerals(locale, offer)}
        />{" "}
        <span className="seccolor tc-mini-period">{t("home.perPeriod")}</span>
      </p>
      <Button variant="primary" href={href} className="tc-mini-btn">
        {t("home.createInstance")}
      </Button>
    </div>
  );
}

/** The read-only preview of the create screen. The prices are the catalog's, as taka only (WPU-X16). */
export function Chooser({
  t,
  locale,
  catalog,
  images,
  region,
  platform,
  blueprint,
  signedIn,
}: {
  t: Tr;
  locale: Locale;
  catalog: PublicCatalog;
  /** WPU-X22: the offered images; "unavailable" hides the image step (R16). */
  images: PublicImages;
  region: string | undefined;
  platform: string | undefined;
  blueprint?: string | undefined;
  signedIn: boolean;
}) {
  const chooser = homeChooser(catalog, images, { region, platform, blueprint });
  const home = localePath(locale, "/");
  // A choice is a link (no script). Changing the location or the platform drops the image choice, which
  // belongs to one location and one platform.
  const link = (r: string, pl: HomePlatform, bp?: string): string =>
    `${home}?region=${r}&platform=${pl}${bp === undefined ? "" : `&blueprint=${encodeURIComponent(bp)}`}#chooser`;
  const create = signedIn ? localePath(locale, "/servers/new") : orderHref(locale);
  return (
    <div id="chooser">
      <h2 className="h4 mergecolor">{t("home.chooserTitle")}</h2>
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
          <nav aria-label={t("home.locationTitle")} className="mb-3">
            <h3 className="h6 mergecolor">{t("home.locationTitle")}</h3>
            {chooser.regions.map((code) => (
              <Button
                key={code}
                variant={code === chooser.region ? "primary" : "secondary"}
                size="sm"
                href={link(code, chooser.platform)}
                className="me-2 mb-1"
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
          <nav aria-label={t("home.platformTitle")} className="mb-3">
            <h3 className="h6 mergecolor">{t("home.platformTitle")}</h3>
            {chooser.platforms.map((key) => (
              <Button
                key={key}
                variant={key === chooser.platform ? "primary" : "secondary"}
                size="sm"
                href={link(chooser.region, key)}
                className="me-2 mb-1"
                icon={key === chooser.platform ? "fas fa-check" : undefined}
              >
                {t(`home.platforms.${key}`)}
                {key === chooser.platform ? (
                  <span className="visually-hidden"> {t("pricing.regionCurrent")}</span>
                ) : null}
              </Button>
            ))}
          </nav>
          {chooser.blueprints.length === 0 ? null : (
            <section aria-label={t("home.imageTitle")} className="mb-3">
              <h3 className="h6 mergecolor">{t("home.imageTitle")}</h3>
              <div className="row g-3">
                {chooser.blueprints.map((image) => {
                  const selected = image.id === chooser.blueprint?.id;
                  return (
                    <div key={image.id} className="col-md-6 col-xl-3">
                      <div className="tc-mini bg-seccolorstyle">
                        <p className="tc-mini-title mergecolor">
                          {image.version === null ? image.name : `${image.name} ${image.version}`}
                        </p>
                        <p className="tc-mini-line seccolor">
                          {t(image.kind === "app" ? "home.imageKindApp" : "home.imageKindOs")}
                        </p>
                        <Button
                          variant={selected ? "primary" : "secondary"}
                          href={link(chooser.region, chooser.platform, image.id)}
                          className="tc-mini-btn"
                          icon={selected ? "fas fa-check" : undefined}
                        >
                          {t(selected ? "home.imageSelected" : "home.imageSelect")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="seccolor small mt-2 mb-0">{t("home.imageNote")}</p>
            </section>
          )}
          <section aria-label={t("home.planTitle")}>
            <h3 className="h6 mergecolor">{t("home.planTitle")}</h3>
            <div className="row g-3">
              {chooser.offers.map((offer) => (
                <div key={offer.id} className="col-md-6 col-xl-3">
                  <PlanMini t={t} locale={locale} offer={offer} href={create} />
                </div>
              ))}
            </div>
            <p className="mt-3 mb-1">
              <a
                href={`${localePath(locale, "/pricing")}?region=${chooser.region}`}
                className="golink"
              >
                {t("home.plansAll")}
              </a>
            </p>
          </section>
          <p className="seccolor small mb-0">{t("home.createNote")}</p>
        </>
      )}
    </div>
  );
}

/** The trust line, low on the page: the answer block of WPU-Z16, the long AWS statement and the price note. */
export function About({
  t,
  statement,
  answer,
}: {
  t: Tr;
  statement: string;
  answer: React.ReactNode;
}) {
  return (
    <section className="bg-seccolorstyle tc-trust">
      <div className="container text-center">
        {answer}
        <p className="seccolor mb-2">{statement}</p>
        <p className="small seccolor mb-0">{t("common.priceNote")}</p>
      </div>
    </section>
  );
}
