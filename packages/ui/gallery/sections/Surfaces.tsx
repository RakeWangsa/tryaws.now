import { useLocale, useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Card } from "../../components/Card.tsx";
import { formatMoney } from "../../components/format.ts";
import { PlanCard, type PlanCardProps } from "../../components/PlanCard.tsx";
import { PlanPicker, type PickerPlan } from "../../components/PlanPicker.tsx";
import { StatTile } from "../../components/StatTile.tsx";
import { toLocale } from "../../components/types.ts";
import { DEMO_BALANCE_MINOR, DEMO_PLAN_PRICES, DEMO_PLAN_SPECS, DEMO_SPEC_ICONS } from "../data.ts";
import { Sample } from "../Sample.tsx";

type PlanId = keyof typeof DEMO_PLAN_PRICES;
const PLAN_IDS: readonly PlanId[] = ["nano", "small", "medium"];

export function Surfaces(): ReactElement {
  const t = useTranslations("Gallery.demo");
  const locale = toLocale(useLocale());

  const specsOf = (id: PlanId): PlanCardProps["specs"] => [
    { icon: DEMO_SPEC_ICONS.cpu, label: t("plan.spec.cpu"), value: DEMO_PLAN_SPECS[id].cpu },
    { icon: DEMO_SPEC_ICONS.ram, label: t("plan.spec.ram"), value: DEMO_PLAN_SPECS[id].ram },
    { icon: DEMO_SPEC_ICONS.disk, label: t("plan.spec.disk"), value: DEMO_PLAN_SPECS[id].disk },
    {
      icon: DEMO_SPEC_ICONS.transfer,
      label: t("plan.spec.transfer"),
      value: DEMO_PLAN_SPECS[id].transfer,
    },
  ];
  const plans: PickerPlan[] = PLAN_IDS.map((id) => ({
    id,
    name: t(`plan.${id}`),
    priceMinor: DEMO_PLAN_PRICES[id],
    lines: [DEMO_PLAN_SPECS[id].cpu, DEMO_PLAN_SPECS[id].ram, DEMO_PLAN_SPECS[id].disk],
  }));

  return (
    <>
      <Sample name="Card" titleKey="Gallery.samples.card">
        <Card title={t("card.title")} titleAs="h4">
          <p className="seccolor mb-0">{t("card.body")}</p>
        </Card>
      </Sample>
      <Sample name="StatTile" titleKey="Gallery.samples.statTile">
        <div className="row">
          <div className="col-md-6 col-lg-4">
            <StatTile
              value={formatMoney(DEMO_BALANCE_MINOR, { locale })}
              description={t("stat.description")}
              tag={{ text: t("stat.tag"), tone: "purple" }}
            />
          </div>
        </div>
      </Sample>
      <Sample name="PlanCard" titleKey="Gallery.samples.planCard">
        <section className="pricing">
          <div className="row">
            <div className="col-md-6 col-lg-4">
              <PlanCard
                name={t("plan.nano")}
                priceMinor={DEMO_PLAN_PRICES.nano}
                specs={specsOf("nano")}
                cta={{ label: t("plan.choose"), href: "#" }}
              />
            </div>
            <div className="col-md-6 col-lg-4">
              <PlanCard
                recommended
                name={t("plan.small")}
                priceMinor={DEMO_PLAN_PRICES.small}
                specs={specsOf("small")}
                cta={{ label: t("plan.choose"), href: "#" }}
              />
            </div>
          </div>
        </section>
      </Sample>
      <Sample name="PlanPicker" titleKey="Gallery.samples.planPicker">
        <PlanPicker name="demo-plan" legend={t("plan.legend")} plans={plans} defaultId="small" />
      </Sample>
    </>
  );
}
