import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { MoneyText } from "./MoneyText";
import { UsdText } from "./UsdText";
import type { LinkComponent, Numerals } from "./types";

export interface PlanSpec {
  /** A theme icon class such as `icon-drives`. */
  icon: string;
  label: string;
  value: string;
}

export interface PlanCardProps {
  name: string;
  /** Paisa. A number throws TypeError (R4). Give this or `priceUsd`. */
  priceMinor?: bigint;
  /** WPU-Y4: the public price in US dollars as plain decimal text of the pricing engine ("5.85"). */
  priceUsd?: string;
  specs: [PlanSpec, PlanSpec, PlanSpec, PlanSpec];
  cta: { label: string; href: string; as?: LinkComponent };
  recommended?: boolean;
  /** The digits of the market setting; the digits of the locale when missing. */
  numerals?: Numerals;
}

/** A plan of the catalog (index.html, `section.pricing`). The price is whole taka, rounded up. */
export function PlanCard({
  name,
  priceMinor,
  priceUsd,
  specs,
  cta,
  recommended = false,
  numerals,
}: PlanCardProps) {
  const t = useTranslations("kit.plan");
  if (priceUsd === undefined && typeof priceMinor !== "bigint") {
    throw new TypeError("PlanCard: priceMinor must be a bigint of paisa, never a number");
  }
  if (priceUsd !== undefined && priceMinor !== undefined) {
    throw new TypeError("PlanCard: give priceMinor or priceUsd, not both");
  }
  return (
    <div className="wrapper">
      {recommended ? <div className="plans badge feat bg-dark">{t("recommended")}</div> : null}
      <div className="top-content bg-seccolorstyle topradius">
        <div className="title">{name}</div>
        <div className="price seccolor">
          {priceUsd !== undefined ? (
            <UsdText text={priceUsd} numerals={numerals} />
          ) : (
            <MoneyText minor={priceMinor as bigint} mode="wholeUp" numerals={numerals} />
          )}{" "}
          <span className="period">{t("perPeriod")}</span>
        </div>
        <Button variant="primary" href={cta.href} as={cta.as}>
          {cta.label}
        </Button>
      </div>
      <ul className="list-info bg-purple">
        {specs.map((spec) => (
          <li key={spec.label}>
            <i className={spec.icon} aria-hidden="true" />{" "}
            <span className="f-14">{spec.label}</span>
            <br /> <span>{spec.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
