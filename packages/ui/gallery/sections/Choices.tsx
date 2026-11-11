import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Button } from "../../components/Button.tsx";
import { ImageTile } from "../../components/ImageTile.tsx";
import { MoneyText } from "../../components/MoneyText.tsx";
import { OptionGroup } from "../../components/OptionGroup.tsx";
import { PriceBreakdown } from "../../components/PriceBreakdown.tsx";
import { SummarySidebar } from "../../components/SummarySidebar.tsx";
import { DEMO_BREAKDOWN, DEMO_IMAGES, DEMO_PLAN_PRICES } from "../data.ts";
import { Sample } from "../Sample.tsx";

export function Choices(): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <>
      <Sample name="OptionGroup" titleKey="Gallery.samples.optionGroup">
        <div className="row">
          <div className="col-md-6">
            <OptionGroup
              kind="radio"
              name="demo-location"
              legend={t("options.locationLegend")}
              hint={t("options.locationHint")}
              defaultValue="singapore"
              options={[
                { value: "singapore", label: t("options.singapore") },
                { value: "mumbai", label: t("options.mumbai") },
              ]}
            />
          </div>
          <div className="col-md-6">
            <OptionGroup
              kind="checkbox"
              name="demo-extras"
              legend={t("options.extrasLegend")}
              defaultValue={["backups"]}
              options={[
                { value: "backups", label: t("options.backups") },
                { value: "static-ip", label: t("options.staticIp") },
              ]}
            />
          </div>
          <div className="col-md-6">
            <OptionGroup
              kind="select"
              name="demo-period"
              legend={t("options.periodLegend")}
              defaultValue="30"
              options={[
                { value: "30", label: t("options.days30") },
                { value: "90", label: t("options.days90") },
              ]}
            />
          </div>
        </div>
      </Sample>
      <Sample name="ImageTile" titleKey="Gallery.samples.imageTile">
        <p className="seccolor">{t("options.imageTitle")}</p>
        <div className="d-flex flex-wrap gap-3">
          {DEMO_IMAGES.map((image, index) => (
            <ImageTile
              key={image.value}
              type="radio"
              name="demo-image"
              value={image.value}
              label={image.label}
              imageSrc={image.src}
              defaultChecked={index === 0}
            />
          ))}
        </div>
      </Sample>
      <Sample name="SummarySidebar" titleKey="Gallery.samples.summarySidebar">
        <div className="row">
          <div className="col-lg-5">
            <SummarySidebar
              title={t("summary.title")}
              planTitle={t("summary.planTitle")}
              planLines={[t("summary.line")]}
              rows={[
                { label: t("summary.plan"), value: t("plan.small") },
                {
                  label: t("summary.price"),
                  value: <MoneyText minor={DEMO_PLAN_PRICES.small} mode="exact" />,
                },
                {
                  label: t("summary.total"),
                  value: <MoneyText minor={DEMO_PLAN_PRICES.small} mode="exact" />,
                  strong: true,
                },
              ]}
              action={<Button variant="primary">{t("summary.pay")}</Button>}
            />
          </div>
        </div>
      </Sample>
      <Sample name="PriceBreakdown" titleKey="Gallery.samples.priceBreakdown">
        <PriceBreakdown
          baseMinor={DEMO_BREAKDOWN.baseMinor}
          steps={[
            {
              code: "demo-1",
              label: t("breakdown.stepOne"),
              amountMinor: DEMO_BREAKDOWN.stepOneMinor,
            },
            {
              code: "demo-2",
              label: t("breakdown.stepTwo"),
              amountMinor: DEMO_BREAKDOWN.stepTwoMinor,
            },
          ]}
          totalMinor={DEMO_BREAKDOWN.totalMinor}
        />
      </Sample>
    </>
  );
}
