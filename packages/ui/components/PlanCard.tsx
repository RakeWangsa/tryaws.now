import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { MoneyText } from "./MoneyText";
import type { LinkComponent, Numerals } from "./types";

export interface PlanSpec {
  /** A theme icon class such as `icon-drives`. */
  icon: string;
  label: string;
  value: string;
}

export interface PlanCardProps {
  name: string;
  /** Paisa. A number throws TypeError (R4). Customers see taka only (WPU-X16). */
  priceMinor: bigint;
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
  specs,
  cta,
  recommended = false,
  numerals,
}: PlanCardProps) {
  const t = useTranslations("kit.plan");
  if (typeof priceMinor !== "bigint") {
    throw new TypeError("PlanCard: priceMinor must be a bigint of paisa, never a number");
  }
  return (
    <div className="wrapper">
      {recommended ? <div className="plans badge feat bg-dark">{t("recommended")}</div> : null}
      <div className="top-content bg-seccolorstyle topradius">
        <div className="title">{name}</div>
        <div className="price seccolor">
          <MoneyText minor={priceMinor} mode="wholeUp" numerals={numerals} />{" "}
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
