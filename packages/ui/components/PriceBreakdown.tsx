import { useTranslations } from "next-intl";
import { MoneyText } from "./MoneyText";

export interface PriceBreakdownStep {
  code: string;
  label: string;
  amountMinor: bigint;
}

export interface PriceBreakdownProps {
  baseMinor: bigint;
  steps: PriceBreakdownStep[];
  totalMinor: bigint;
}

function assertBigint(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`PriceBreakdown: ${name} must be a bigint of paisa (R4)`);
  }
}

/**
 * The price table of checkout.html: the AWS service price, every pricing step in order, the total.
 * A breakdown that does not add up is a defect, not a price to show (R16).
 */
export function PriceBreakdown({ baseMinor, steps, totalMinor }: PriceBreakdownProps) {
  const t = useTranslations("kit.priceBreakdown");
  assertBigint(baseMinor, "baseMinor");
  assertBigint(totalMinor, "totalMinor");
  let sum = baseMinor;
  for (const step of steps) {
    assertBigint(step.amountMinor, `steps[${step.code}].amountMinor`);
    sum += step.amountMinor;
  }
  if (sum !== totalMinor) {
    throw new RangeError("PriceBreakdown: baseMinor plus the steps does not equal totalMinor");
  }

  return (
    <div className="table-responsive-sm">
      <table className="table compare min">
        <tbody>
          <tr>
            <th scope="row" className="seccolor">
              {t("base")}
            </th>
            <td className="text-end seccolor">
              <MoneyText minor={baseMinor} mode="exact" />
            </td>
          </tr>
          {steps.map((step) => (
            <tr key={step.code}>
              <th scope="row" className="seccolor">
                {step.label}
              </th>
              <td className="text-end seccolor">
                <MoneyText minor={step.amountMinor} mode="exact" />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="seccolor">
              <b>{t("total")}</b>
            </th>
            <td className="text-end seccolor">
              <b>
                <MoneyText minor={totalMinor} mode="exact" />
              </b>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
