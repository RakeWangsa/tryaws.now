import { Button, MoneyText, PlanCard } from "@tc/ui";
import type { PlanSpec } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { PublicOffer } from "../../../../server/public/catalog.ts";
type PlanSpecs = PublicOffer["specs"];

// The pieces that show offers of the live catalog. Nothing here computes money: the price of an
// offer is the engine's `totalMinor`, formatted by MoneyText (whole taka, rounded up, 16.8, R4).

/** What `useTranslations("Public")` gives, as far as these pieces use it. */
export interface Tr {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** The theme's line icons of the four specification lines of a plan card. */
const ICON = {
  cpu: "icon-cpu",
  ram: "icon-ram",
  disk: "icon-drivessd",
  transfer: "icon-speed",
} as const;

export function locationName(t: Tr, region: string): string {
  return t.has(`location.${region}`) ? t(`location.${region}`) : region;
}

function productName(t: Tr, family: string): string {
  return t.has(`product.${family}`) ? t(`product.${family}`) : family;
}

/** "Cloud Server 4 GB" without the location. */
export function planName(t: Tr, offer: PublicOffer): string {
  const product = productName(t, offer.family);
  return offer.specs.ramGb === undefined
    ? product
    : t("spec.planOf", { product, ram: offer.specs.ramGb });
}

/** "Cloud Server 4 GB · Singapore": a card or a row is one plan at one location. */
export function offerName(t: Tr, offer: PublicOffer): string {
  return t("spec.nameAt", { name: planName(t, offer), location: locationName(t, offer.region) });
}

const gb = (t: Tr, value: number | string | undefined): string =>
  value === undefined ? t("spec.none") : t("spec.gb", { count: String(value) });

export function specValues(t: Tr, specs: PlanSpecs) {
  return {
    cpu:
      specs.vcpus === undefined
        ? t("spec.none")
        : t("spec.cpuValue", { count: String(specs.vcpus) }),
    ram: gb(t, specs.ramGb),
    disk: gb(t, specs.diskGb),
    transfer: gb(t, specs.transferGb),
  };
}

export function cardSpecs(t: Tr, specs: PlanSpecs): [PlanSpec, PlanSpec, PlanSpec, PlanSpec] {
  const v = specValues(t, specs);
  return [
    { icon: ICON.cpu, label: t("spec.cpu"), value: v.cpu },
    { icon: ICON.ram, label: t("spec.ram"), value: v.ram },
    { icon: ICON.disk, label: t("spec.disk"), value: v.disk },
    { icon: ICON.transfer, label: t("spec.transfer"), value: v.transfer },
  ];
}

/** Where "Order now" goes: the sign-in page, and then the configurator (U12: a relative allowed path). */
export function orderHref(locale: Locale): string {
  return `${localePath(locale, "/login")}?next=${encodeURIComponent("/servers/new")}`;
}

export function OfferCard({
  t,
  locale,
  offer,
  href,
  label,
  recommended,
}: {
  t: Tr;
  locale: Locale;
  offer: PublicOffer;
  href?: string;
  label?: string;
  recommended?: boolean;
}) {
  return (
    <PlanCard
      name={offerName(t, offer)}
      priceMinor={offer.priceMinor}
      specs={cardSpecs(t, offer.specs)}
      cta={{ label: label ?? t("common.orderNow"), href: href ?? orderHref(locale) }}
      recommended={recommended === true}
    />
  );
}

/** `table.table.compare` of pricing.html: one row for each plan at each location. */
export function OfferTable({
  t,
  locale,
  offers,
  caption,
}: {
  t: Tr;
  locale: Locale;
  offers: readonly PublicOffer[];
  caption: string;
}) {
  return (
    <div className="table-responsive-lg">
      <table className="table compare">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colPlan")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("cloudServers.colLocation")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colMemory")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colDisk")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colTransfer")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colMonthly")}
            </th>
            <th scope="col" className="title mergecolor border-start-0">
              {t("pricing.colOrder")}
            </th>
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => {
            const v = specValues(t, offer.specs);
            return (
              <tr key={offer.id}>
                <th scope="row">{planName(t, offer)}</th>
                <td>{locationName(t, offer.region)}</td>
                <td>{v.ram}</td>
                <td>{v.disk}</td>
                <td>{v.transfer}</td>
                <td>
                  <b className="c-black mergecolor">
                    <MoneyText minor={offer.priceMinor} mode="wholeUp" />
                  </b>
                </td>
                <td>
                  <Button variant="primary" href={orderHref(locale)}>
                    {t("common.orderNow")}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
