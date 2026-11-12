"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type ChangeEvent } from "react";
import { formatMoney } from "./format";
import { MoneyText } from "./MoneyText";
import { toLocale, type Numerals } from "./types";

export interface PickerPlan {
  id: string;
  name: string;
  /** Paisa. A number throws TypeError (R4). */
  priceMinor: bigint;
  lines: string[];
  /**
   * WPU-G10. A plan the customer cannot pick now (for example a plan too small for the chosen image).
   * The radio is disabled, the slider skips it, and `note` says why.
   */
  disabled?: boolean;
  note?: string;
}

export interface PlanPickerProps {
  /** The name of the hidden input that carries the chosen plan id in the form. */
  name: string;
  legend: string;
  plans: PickerPlan[];
  defaultId?: string;
  value?: string;
  onChange?: (id: string) => void;
  /** The digits of the market setting; the digits of the locale when missing. */
  numerals?: Numerals;
}

/**
 * One choice among plans: radio cards on phones, a slider from 992 px. Both write one state, and one
 * hidden input carries the plan id. With `value` the parent owns the state.
 */
export function PlanPicker({
  name,
  legend,
  plans,
  defaultId,
  value,
  onChange,
  numerals,
}: PlanPickerProps) {
  const t = useTranslations("kit.plan");
  const locale = toLocale(useLocale());
  const base = useId();
  const [inner, setInner] = useState<string | undefined>(defaultId);

  const seen = new Set<string>();
  for (const plan of plans) {
    if (typeof plan.priceMinor !== "bigint") {
      throw new TypeError(`PlanPicker: the price of plan ${plan.id} must be a bigint of paisa`);
    }
    if (seen.has(plan.id)) throw new RangeError(`PlanPicker: duplicate plan id ${plan.id}`);
    seen.add(plan.id);
  }

  if (plans.length === 0) return <p className="seccolor">{t("none")}</p>;

  const firstEnabled = plans.find((plan) => plan.disabled !== true) ?? (plans[0] as PickerPlan);
  const wanted = value ?? inner ?? firstEnabled.id;
  const index = plans.findIndex((plan) => plan.id === wanted);
  if (index < 0) throw new RangeError(`PlanPicker: unknown plan id ${wanted}`);
  const selected = plans[index] as PickerPlan;

  const choose = (id: string): void => {
    if (value === undefined) setInner(id);
    onChange?.(id);
  };
  const onRange = (event: ChangeEvent<HTMLInputElement>): void => {
    const at = Number(event.target.value);
    // A disabled plan is skipped: to the nearest plan that can be picked, upward first.
    const next =
      plans.slice(at).find((plan) => plan.disabled !== true) ??
      [...plans.slice(0, at)].reverse().find((plan) => plan.disabled !== true);
    if (next) choose(next.id);
  };
  const valueText = `${selected.name}, ${formatMoney(selected.priceMinor, { locale, mode: "wholeUp", numerals })}`;

  return (
    <fieldset>
      <legend className="seccolor h6 mb-4">{legend}</legend>
      <ul className="tc-plan-list d-lg-none">
        {plans.map((plan, i) => {
          const id = `${base}-${i}`;
          return (
            <li key={plan.id}>
              <input
                type="radio"
                id={id}
                name={`${name}__ui`}
                value={plan.id}
                className="tc-plan-radio"
                checked={plan.id === selected.id}
                disabled={plan.disabled === true}
                onChange={() => choose(plan.id)}
              />
              <label htmlFor={id} className="tc-plan-card bg-seccolorstyle noshadow">
                <span className="title mergecolor tc-plan-name">{plan.name}</span>
                {plan.lines.map((line) => (
                  <span key={line} className="d-block seccolor">
                    {line}
                  </span>
                ))}
                {plan.disabled === true && plan.note !== undefined ? (
                  <span className="d-block seccolor">
                    <i className="fas fa-info-circle me-1" aria-hidden="true" />
                    {plan.note}
                  </span>
                ) : null}
                <span className="d-block price seccolor">
                  <MoneyText minor={plan.priceMinor} mode="wholeUp" numerals={numerals} />{" "}
                  <span className="period">{t("perPeriod")}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="wpc-cloud-range d-none d-lg-block">
        <input
          type="range"
          className="form-range tc-plan-range"
          min={0}
          max={plans.length - 1}
          step={1}
          value={index}
          onChange={onRange}
          aria-label={legend}
          aria-valuetext={valueText}
        />
        <ul className="tc-plan-range-labels d-flex justify-content-between list-unstyled seccolor">
          {plans.map((plan) => (
            <li key={plan.id} {...(plan.disabled === true ? { "aria-disabled": true } : {})}>
              {plan.name}
            </li>
          ))}
        </ul>
      </div>
      <input type="hidden" name={name} value={selected.id} />
    </fieldset>
  );
}
